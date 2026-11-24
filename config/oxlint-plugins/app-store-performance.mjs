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
function deferredSelectorRule(sourceCode, inspect) {
  const state = createRuleState(sourceCode)
  return {
    ImportDeclaration(node) {
      recordImports(node, state)
    },
    CallExpression(node) {
      if (isAppStoreCall(node, state)) {
        state.deferredCalls.push(node)
      }
    },
    'Program:exit'() {
      for (const node of state.deferredCalls) {
        const { selector: argument, shallow } = unwrapShallowSelector(node.arguments[0], state)
        const reports = inspect({
          selector: resolveSelector(argument, state),
          shallow,
          state
        })
        for (const report of [reports].flat()) {
          if (report) {
            this.report(report)
          }
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

// Fleet-keyed maps that get a new reference whenever any one host, pane, tab or worktree changes,
// so a whole-map selector re-renders its owner for every other entry's update.
const HOT_STORE_FIELDS = new Set([
  'runtimeStatusByEnvironmentId',
  'agentStatusByPaneKey',
  'acknowledgedAgentsByPaneKey',
  'paneForegroundAgentByPaneKey',
  'runtimeAgentOrchestrationByPaneKey',
  'runtimePaneTitlesByTabId',
  'ptyIdsByTabId',
  'gitStatusByWorktree',
  'tabsByWorktree',
  'unifiedTabsByWorktree',
  'groupsByWorktree',
  'layoutByWorktree',
  'activeTabIdByWorktree',
  'activeGroupIdByWorktree',
  'browserTabsByWorktree',
  'browserPagesByWorkspace',
  'terminalLayoutsByTabId',
  'lastTerminalInputAtByPaneKey',
  'lastVisitedAtByWorktreeId',
  'agentSenderPublicationsByHost'
])

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

/** Fallbacks, branches, local const aliases and one level under useShallow: values reaching the subscriber unchanged. */
function wholeValueCandidates(expression, shallow, localInit, seen = [new Set(), new Set()]) {
  const expand = (node, nested = shallow) => wholeValueCandidates(node, nested, localInit, seen)
  if (expression?.type === 'LogicalExpression') {
    // A truthy map on the left of `&&` never reaches the subscriber.
    const sides =
      expression.operator === '&&' ? [expression.right] : [expression.left, expression.right]
    return sides.flatMap((side) => expand(side))
  }
  if (expression?.type === 'ConditionalExpression') {
    return [expression.consequent, expression.alternate].flatMap((branch) => expand(branch))
  }
  // One visited set per shallow depth: an alias can be reached both inside and outside a useShallow value.
  const visited = seen[shallow ? 1 : 0]
  const init =
    expression?.type === 'Identifier' && !visited.has(expression) ? localInit(expression) : null
  if (init) {
    visited.add(expression)
    return [expression, ...expand(init)]
  }
  return shallow
    ? [expression, ...shallowValues(expression, localInit).flatMap((value) => expand(value, false))]
    : [expression]
}

/** A property's static name, or the property itself when its key is only known at runtime. */
function propertyKey(property) {
  if (!property.computed) {
    return String(property.key.name ?? property.key.value)
  }
  return property.key.type === 'Literal' ? String(property.key.value) : property
}

/** A useShallow result's top-level values after local spreads, where a later key overrides an earlier one. */
function shallowValues(literal, localInit) {
  const byKey = new Map()
  const expanded = new Set()
  const resolve = (node) => {
    for (const chain = new Set(); node?.type === 'Identifier' && !chain.has(node);) {
      chain.add(node)
      node = localInit(node)
    }
    return node?.type === 'ObjectExpression' || node?.type === 'ArrayExpression' ? node : null
  }
  // Walked last to first, so the first value seen for a key is the one that survives. A container
  // already expanded at a later position has settled its keys, so each literal is walked once.
  const collect = (container) => {
    if (expanded.has(container)) {
      return
    }
    expanded.add(container)
    const entries =
      container.type === 'ObjectExpression' ? container.properties : container.elements
    for (const entry of entries.toReversed()) {
      if (entry?.type === 'SpreadElement') {
        const spread = resolve(entry.argument)
        if (spread) {
          collect(spread)
        }
      } else if (entry) {
        // Array elements keep their own identity: an index override is not modelled, so it errs toward reporting.
        const key = entry.type === 'Property' ? propertyKey(entry) : entry
        if (!byKey.has(key)) {
          byKey.set(key, entry.type === 'Property' ? entry.value : entry)
        }
      }
    }
  }
  if (literal?.type === 'ObjectExpression' || literal?.type === 'ArrayExpression') {
    collect(literal)
  }
  return [...byKey.values()]
}

function noWholeHotMapSelectorRule(sourceCode) {
  return deferredSelectorRule(sourceCode, ({ selector, shallow, state }) => {
    if (!selector) {
      return null
    }
    const localInit = (identifier) => {
      const declaration = selectorLocalConstant(variableFor(identifier, state), selector)
      return declaration?.id.type === 'Identifier' ? declaration.init : null
    }
    const reports = new Map()
    for (const expression of returnedExpressions(selector).flatMap((returned) =>
      wholeValueCandidates(returned, shallow, localInit)
    )) {
      const field = selectorValue(expression, selector, state)
      if (HOT_STORE_FIELDS.has(field) && !reports.has(field)) {
        reports.set(field, {
          node: expression,
          message: `The whole ${field} map changes whenever any entry does. Select the derived answer for your own host/item with a stable result (see paired-runtime-parking-capabilities.ts), or add a disable comment with a reason if this consumer needs every entry.`
        })
      }
    }
    return [...reports.values()]
  })
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
