const ALLOCATING_METHODS = new Set([
  'filter',
  'flat',
  'flatMap',
  'map',
  'toReversed',
  'toSorted',
  'toSpliced',
  'with'
])
const ALLOCATING_OBJECT_STATICS = new Set([
  'assign',
  'create',
  'entries',
  'fromEntries',
  'keys',
  'values'
])
const FUNCTION_NODES = new Set([
  'ArrowFunctionExpression',
  'FunctionDeclaration',
  'FunctionExpression'
])

function identifierName(node) {
  return node?.type === 'Identifier' ? node.name : null
}

function propertyName(node) {
  if (node?.type !== 'MemberExpression') {
    return null
  }
  if (!node.computed) {
    return identifierName(node.property)
  }
  return node.property?.type === 'Literal' && typeof node.property.value === 'string'
    ? node.property.value
    : null
}

function functionNode(node) {
  return FUNCTION_NODES.has(node?.type) ? node : null
}

function returnedExpressions(selector) {
  if (!functionNode(selector)) {
    return []
  }
  if (selector.body.type !== 'BlockStatement') {
    return [selector.body]
  }
  const expressions = []
  const visit = (node) => {
    if (!node || typeof node !== 'object') {
      return
    }
    if (node !== selector.body && FUNCTION_NODES.has(node.type)) {
      return
    }
    if (node.type === 'ReturnStatement') {
      if (node.argument) {
        expressions.push(node.argument)
      }
      return
    }
    for (const [key, child] of Object.entries(node)) {
      if (key === 'parent') {
        continue
      }
      if (Array.isArray(child)) {
        child.forEach(visit)
      } else {
        visit(child)
      }
    }
  }
  visit(selector.body)
  return expressions
}

function unwrapShallowSelector(selector, state) {
  if (
    selector?.type === 'CallExpression' &&
    selector.callee.type === 'Identifier' &&
    state.hookNames.has(selector.callee.name) &&
    state.shallowHooks.has(variableFor(selector.callee, state))
  ) {
    return { selector: selector.arguments[0], shallow: true }
  }
  return { selector, shallow: false }
}

function isIdentitySelector(selector) {
  const parameter = functionNode(selector)?.params[0]
  if (parameter?.type !== 'Identifier') {
    return false
  }
  return returnedExpressions(selector).some(
    (expression) => expression.type === 'Identifier' && expression.name === parameter.name
  )
}

// Inline selectors flag ANY allocating branch; delegated helpers require EVERY branch so cache.get(k) ?? build(state) remains valid.
function allocates(expression, everyBranch) {
  const branches =
    expression?.type === 'ConditionalExpression'
      ? [expression.consequent, expression.alternate]
      : expression?.type === 'LogicalExpression'
        ? [expression.left, expression.right]
        : null
  if (branches) {
    return everyBranch
      ? branches.every((branch) => allocates(branch, true))
      : branches.some((branch) => allocates(branch, false))
  }
  if (
    expression?.type === 'ArrayExpression' ||
    expression?.type === 'ObjectExpression' ||
    expression?.type === 'NewExpression'
  ) {
    return true
  }
  if (expression?.type !== 'CallExpression') {
    return false
  }
  const callee = expression.callee
  const method = propertyName(callee)
  return (
    ALLOCATING_METHODS.has(method) ||
    (identifierName(callee.object) === 'Object' && ALLOCATING_OBJECT_STATICS.has(method))
  )
}

function isAllocatingExpression(expression) {
  return allocates(expression, false)
}

// Project-local zustand hooks follow the use<Name>Store convention; React's
// useSyncExternalStore matches that shape but is not a store subscription.
const STORE_HOOK_NAME = /^use[A-Z][A-Za-z0-9]*Store$/
const NON_STORE_HOOKS = new Set(['useSyncExternalStore'])

function isLocalModuleSource(source) {
  return typeof source === 'string' && (source.startsWith('.') || source.startsWith('@/'))
}

/** Module scope only: a component-local helper must not shadow a same-named import. */
function isModuleScope(node) {
  const parent = node.parent
  return (
    parent?.type === 'Program' ||
    (parent?.type === 'ExportNamedDeclaration' && parent.parent?.type === 'Program')
  )
}

/** Resolve the binding at the use site, including nested lexical shadows. */
function variableFor(node, state) {
  const name = identifierName(node)
  for (let scope = name && state.sourceCode.getScope(node); scope; scope = scope.upper) {
    const variable = scope.set.get(name)
    if (variable) {
      return variable
    }
  }
  return null
}

/** Inline function, or a module-scope selector referenced by its lexical binding. */
function resolveSelector(argument, state) {
  if (functionNode(argument)) {
    return argument
  }
  const definition = variableFor(argument, state)?.defs[0]
  const declaration = definition?.node
  if (
    definition?.type === 'FunctionName' &&
    declaration.type === 'FunctionDeclaration' &&
    isModuleScope(declaration)
  ) {
    return declaration
  }
  return definition?.type === 'Variable' &&
    declaration.type === 'VariableDeclarator' &&
    isModuleScope(declaration.parent)
    ? functionNode(declaration.init)
    : null
}

// Inspect one delegated module helper hop to catch hidden allocations; leave unresolved helpers alone.
function expandThroughNamedHelper(expression, state) {
  const helper =
    expression?.type === 'CallExpression' && expression.callee.type === 'Identifier'
      ? resolveSelector(expression.callee, state)
      : undefined
  const returned = helper ? returnedExpressions(helper) : []
  return returned.length > 0 && returned.every((entry) => allocates(entry, true))
    ? returned
    : [expression]
}

function createRuleState(sourceCode) {
  return {
    appStoreHooks: new Set(),
    shallowHooks: new Set(),
    hookNames: new Set(),
    sourceCode,
    deferredCalls: []
  }
}

function recordImports(node, state) {
  const source = node.source?.value
  for (const specifier of node.specifiers) {
    if (specifier.type !== 'ImportSpecifier') {
      continue
    }
    const imported = identifierName(specifier.imported)
    const shallow = source === 'zustand/react/shallow' && imported === 'useShallow'
    // useAppStore is the app store wherever it is re-exported from; sibling
    // stores are trusted by naming convention only when they come from this codebase.
    const store =
      STORE_HOOK_NAME.test(imported ?? '') &&
      !NON_STORE_HOOKS.has(imported) &&
      (imported === 'useAppStore' || isLocalModuleSource(source))
    // Why: getScope builds the whole scope tree, so only resolve bindings this rule tracks.
    const variable = shallow || store ? variableFor(specifier.local, state) : null
    if (!variable) {
      continue
    }
    state.hookNames.add(specifier.local.name)
    if (shallow) {
      state.shallowHooks.add(variable)
    } else {
      state.appStoreHooks.add(variable)
    }
  }
}

function isAppStoreCall(node, state) {
  return (
    node.callee.type === 'Identifier' &&
    state.hookNames.has(node.callee.name) &&
    state.appStoreHooks.has(variableFor(node.callee, state)) &&
    node.optional !== true
  )
}

function requireSelectorRule(sourceCode) {
  const state = createRuleState(sourceCode)
  return {
    ImportDeclaration(node) {
      recordImports(node, state)
    },
    CallExpression(node) {
      if (isAppStoreCall(node, state) && node.arguments.length === 0) {
        this.report({
          node,
          message:
            'Pass a selector to useAppStore so the component does not rerender for every store write.'
        })
      }
    }
  }
}

// Judge at Program:exit so selectors declared after call sites resolve.
function deferredSelectorRule(sourceCode, inspect, inspectOtherCall) {
  const state = createRuleState(sourceCode)
  const otherCalls = []
  return {
    ImportDeclaration(node) {
      recordImports(node, state)
    },
    CallExpression(node) {
      if (isAppStoreCall(node, state)) {
        state.deferredCalls.push(node)
      } else if (inspectOtherCall) {
        otherCalls.push(node)
      }
    },
    'Program:exit'() {
      for (const node of otherCalls) {
        for (const report of inspectOtherCall(node, state)) {
          this.report(report)
        }
      }
      for (const node of state.deferredCalls) {
        const { selector: argument, shallow } = unwrapShallowSelector(node.arguments[0], state)
        const report = inspect({
          selector: resolveSelector(argument, state),
          shallow,
          state
        })
        if (report) {
          this.report(report)
        }
      }
    }
  }
}

function noIdentitySelectorRule(sourceCode) {
  return deferredSelectorRule(sourceCode, ({ selector }) =>
    isIdentitySelector(selector)
      ? {
          node: selector,
          message:
            'Select the smallest required fields instead of subscribing to the entire app store.'
        }
      : null
  )
}

function noFreshSelectorResultRule(sourceCode) {
  return deferredSelectorRule(sourceCode, ({ selector, shallow, state }) => {
    if (shallow || !selector) {
      return null
    }
    const freshResult = returnedExpressions(selector)
      .flatMap((expression) => expandThroughNamedHelper(expression, state))
      .find(isAllocatingExpression)
    return freshResult
      ? {
          node: freshResult,
          message:
            'This selector returns a fresh reference on every store write; select a stable field, cache the result, or use useShallow.'
        }
      : null
  })
}

// Host observations replace this map on every meaningful change (runtime-status.ts).
const HOT_STORE_FIELDS = new Set(['runtimeStatusByEnvironmentId'])

function selectorLocalConstant(variable, selector) {
  const definition = variable?.defs[0]
  const declaration = definition?.node
  if (definition?.type !== 'Variable' || declaration.parent.kind !== 'const') {
    return null
  }
  for (let parent = declaration.parent; parent; parent = parent.parent) {
    if (parent === selector) {
      return declaration
    }
  }
  return null
}

// Resolve only the selector parameter and its local const aliases, never a same-named outer value.
function selectorValue(expression, selector, state, seen = new Set()) {
  if (expression?.type === 'MemberExpression') {
    const field = propertyName(expression)
    return HOT_STORE_FIELDS.has(field) &&
      selectorValue(expression.object, selector, state, seen) === 'state'
      ? field
      : null
  }
  const variable = variableFor(expression, state)
  if (!variable || seen.has(variable)) {
    return null
  }
  seen.add(variable)
  const parameter = selector.params[0]
  if (parameter?.type === 'Identifier' && variableFor(parameter, state) === variable) {
    return 'state'
  }
  const declaration = selectorLocalConstant(variable, selector)
  const pattern = declaration?.id ?? parameter
  if (pattern?.type === 'ObjectPattern') {
    const property = pattern.properties.find(
      (entry) => entry.type === 'Property' && variable.identifiers.includes(entry.value)
    )
    const field = property && !property.computed ? identifierName(property.key) : null
    if (
      HOT_STORE_FIELDS.has(field) &&
      (pattern === parameter || selectorValue(declaration.init, selector, state, seen) === 'state')
    ) {
      return field
    }
  }
  return declaration?.id.type === 'Identifier'
    ? selectorValue(declaration.init, selector, state, seen)
    : null
}

// Every tab write replaces the tab maps (terminal title batches included), like host observations do the status map.
const HOT_TRIGGER_FIELDS = new Set([...HOT_STORE_FIELDS, 'unifiedTabsByWorktree', 'tabsByWorktree'])
const EFFECT_HOOKS = new Set(['useEffect', 'useLayoutEffect'])

function visitNodes(root, visit) {
  const walk = (node) => {
    if (!node || typeof node !== 'object' || typeof node.type !== 'string') {
      return
    }
    visit(node)
    for (const [key, child] of Object.entries(node)) {
      if (key !== 'parent') {
        ;(Array.isArray(child) ? child : [child]).forEach(walk)
      }
    }
  }
  walk(root)
}

function isAppStoreMethodCall(node, method, state) {
  const object = node.callee.object
  return (
    propertyName(node.callee) === method &&
    object?.type === 'Identifier' &&
    state.hookNames.has(object.name) &&
    state.appStoreHooks.has(variableFor(object, state))
  )
}

function parameterField(expression, parameter, state) {
  const field = propertyName(expression)
  return HOT_TRIGGER_FIELDS.has(field) &&
    parameter?.type === 'Identifier' &&
    expression.object.type === 'Identifier' &&
    variableFor(expression.object, state) === variableFor(parameter, state)
    ? field
    : null
}

// `state.map !== previous.map` in a store listener reruns its work on every write to that whole map.
function wholeMapListenerTriggers(listener, state) {
  const [current, previous] = listener?.params ?? []
  const triggers = []
  if (!current || !previous) {
    return triggers
  }
  visitNodes(listener.body, (node) => {
    if (node.type !== 'BinaryExpression' || !['===', '!==', '==', '!='].includes(node.operator)) {
      return
    }
    const sides = [
      [node.left, node.right],
      [node.right, node.left]
    ]
    const field = sides
      .map(([own, other]) => [
        parameterField(own, current, state),
        parameterField(other, previous, state)
      ])
      .find(([own, other]) => own && own === other)?.[0]
    if (field) {
      triggers.push({ node, field })
    }
  })
  return triggers
}

// `getState().map` (or a `const s = getState()` alias) used whole, not indexed or `.get`-ed, inside an effect.
function wholeMapEffectReads(effect, state) {
  const snapshots = new Set()
  visitNodes(effect.body, (node) => {
    if (
      node.type === 'VariableDeclarator' &&
      node.id.type === 'Identifier' &&
      node.init?.type === 'CallExpression' &&
      isAppStoreMethodCall(node.init, 'getState', state)
    ) {
      snapshots.add(variableFor(node.id, state))
    }
  })
  const reads = []
  visitNodes(effect.body, (node) => {
    const field = propertyName(node)
    const object = node.object
    if (
      HOT_TRIGGER_FIELDS.has(field) &&
      ((object?.type === 'CallExpression' && isAppStoreMethodCall(object, 'getState', state)) ||
        (object?.type === 'Identifier' && snapshots.has(variableFor(object, state)))) &&
      !(node.parent?.type === 'MemberExpression' && node.parent.object === node)
    ) {
      reads.push({ node, field })
    }
  })
  return reads
}

function wholeHotMapTriggerReports(node, state) {
  if (isAppStoreMethodCall(node, 'subscribe', state)) {
    return wholeMapListenerTriggers(functionNode(node.arguments[0]), state).map(
      ({ node: trigger, field }) => ({
        node: trigger,
        message: `This listener reruns on every write to the whole ${field} map. Compare the derived answer it needs (see structured-agent-session-tabs.ts), or add a disable comment with a reason if it needs every entry.`
      })
    )
  }
  const effect = functionNode(node.arguments[0])
  if (node.callee.type !== 'Identifier' || !EFFECT_HOOKS.has(node.callee.name) || !effect) {
    return []
  }
  return wholeMapEffectReads(effect, state).map(({ node: read, field }) => ({
    node: read,
    message: `This effect reads the whole ${field} map. Read the entry it needs or a derived index, or add a disable comment with a reason if it needs every entry.`
  }))
}

function noWholeHotMapSelectorRule(sourceCode) {
  return deferredSelectorRule(
    sourceCode,
    ({ selector, state }) => {
      if (!selector) {
        return null
      }
      const result = returnedExpressions(selector).find((expression) =>
        HOT_STORE_FIELDS.has(selectorValue(expression, selector, state))
      )
      return result
        ? {
            node: result,
            message:
              'This whole host-status map changes for every host. Select the derived answer for your own host/item with a stable result (see paired-runtime-parking-capabilities.ts), or add a disable comment with a reason if this consumer needs every host.'
          }
        : null
    },
    wholeHotMapTriggerReports
  )
}

/** useShallow compares one level deep, so a fresh reference nested inside its result never matches. */
function nestedFreshValues(expression) {
  if (expression?.type === 'ObjectExpression') {
    return expression.properties
      .map((property) => (property.type === 'Property' ? property.value : null))
      .filter(Boolean)
  }
  if (expression?.type === 'ArrayExpression') {
    return expression.elements.filter(Boolean)
  }
  return []
}

function noNestedFreshUnderShallowRule(sourceCode) {
  return deferredSelectorRule(sourceCode, ({ selector, shallow, state }) => {
    if (!shallow || !selector) {
      return null
    }
    const nestedFresh = returnedExpressions(selector)
      .flatMap((expression) => expandThroughNamedHelper(expression, state))
      .flatMap(nestedFreshValues)
      .flatMap((expression) => expandThroughNamedHelper(expression, state))
      .find(isAllocatingExpression)
    return nestedFresh
      ? {
          node: nestedFresh,
          message:
            'useShallow compares only one level deep, so this nested fresh reference changes on every store write and defeats the memo; project the primitives the component actually renders.'
        }
      : null
  })
}

// Skip JS AST deserialization in files that cannot name a store hook.
const STORE_HOOK_TEXT = /use[A-Z][A-Za-z0-9]*Store/

function bindContext(createVisitors) {
  return (context) => {
    if (!STORE_HOOK_TEXT.test(context.sourceCode.text) && !context.sourceCode.text.includes('\\')) {
      return {}
    }
    if (
      createVisitors === noWholeHotMapSelectorRule &&
      /\.(?:test|spec)\.[^/\\]+$/.test(context.filename)
    ) {
      return {}
    }
    const visitors = createVisitors(context.sourceCode)
    for (const [nodeType, visit] of Object.entries(visitors)) {
      visitors[nodeType] = visit.bind(context)
    }
    return visitors
  }
}

export default {
  meta: { name: 'app-store-performance' },
  rules: {
    'require-selector': { create: bindContext(requireSelectorRule) },
    'no-identity-selector': { create: bindContext(noIdentitySelectorRule) },
    'no-fresh-selector-result': { create: bindContext(noFreshSelectorResultRule) },
    'no-whole-hot-map-selector': { create: bindContext(noWholeHotMapSelectorRule) },
    'no-nested-fresh-under-shallow': { create: bindContext(noNestedFreshUnderShallowRule) }
  }
}
