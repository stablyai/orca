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

function returnedExpressions(selector) {
  if (selector?.type !== 'ArrowFunctionExpression' && selector?.type !== 'FunctionExpression') {
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
    if (
      node !== selector.body &&
      ['ArrowFunctionExpression', 'FunctionDeclaration', 'FunctionExpression'].includes(node.type)
    ) {
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

function unwrapShallowSelector(selector, shallowHooks) {
  if (
    selector?.type === 'CallExpression' &&
    selector.callee.type === 'Identifier' &&
    shallowHooks.has(selector.callee.name)
  ) {
    return { selector: selector.arguments[0], shallow: true }
  }
  return { selector, shallow: false }
}

function isIdentitySelector(selector) {
  if (selector?.type !== 'ArrowFunctionExpression' && selector?.type !== 'FunctionExpression') {
    return false
  }
  const parameter = selector.params[0]
  if (parameter?.type !== 'Identifier') {
    return false
  }
  return returnedExpressions(selector).some(
    (expression) => expression.type === 'Identifier' && expression.name === parameter.name
  )
}

function isAllocatingExpression(expression) {
  if (expression?.type === 'ConditionalExpression') {
    return (
      isAllocatingExpression(expression.consequent) || isAllocatingExpression(expression.alternate)
    )
  }
  if (expression?.type === 'LogicalExpression') {
    return isAllocatingExpression(expression.left) || isAllocatingExpression(expression.right)
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
  const method = propertyName(expression.callee)
  if (method && ALLOCATING_METHODS.has(method)) {
    return true
  }
  const callee = expression.callee
  return (
    callee.type === 'MemberExpression' &&
    identifierName(callee.object) === 'Object' &&
    ['assign', 'create', 'entries', 'fromEntries', 'keys', 'values'].includes(propertyName(callee))
  )
}

function importedLocalName(specifier, importedName) {
  if (specifier.type !== 'ImportSpecifier' || identifierName(specifier.imported) !== importedName) {
    return null
  }
  return identifierName(specifier.local)
}

// Project-local zustand hooks follow the use<Name>Store convention; React's
// useSyncExternalStore matches that shape but is not a store subscription.
const STORE_HOOK_NAME = /^use[A-Z][A-Za-z0-9]*Store$/
const NON_STORE_HOOKS = new Set(['useSyncExternalStore'])

function isLocalModuleSource(source) {
  return typeof source === 'string' && (source.startsWith('.') || source.startsWith('@/'))
}

function isStoreHookName(name) {
  return typeof name === 'string' && STORE_HOOK_NAME.test(name) && !NON_STORE_HOOKS.has(name)
}

function selectorFunction(node) {
  return node?.type === 'ArrowFunctionExpression' || node?.type === 'FunctionExpression'
    ? node
    : null
}

/** Records module-scope `const selectX = (state) => ...` so identifier selectors resolve. */
function recordNamedSelector(node, state) {
  if (node.type === 'FunctionDeclaration') {
    const name = identifierName(node.id)
    if (name) {
      state.namedSelectors.set(name, node)
    }
    return
  }
  for (const declarator of node.declarations ?? []) {
    const name = identifierName(declarator.id)
    const initializer = selectorFunction(declarator.init)
    if (name && initializer) {
      state.namedSelectors.set(name, initializer)
    }
  }
}

/** Inline function, or a module-scope selector referenced by name. */
function resolveSelector(argument, state) {
  const inline = selectorFunction(argument)
  if (inline) {
    return inline
  }
  const name = identifierName(argument)
  return name ? (state.namedSelectors.get(name) ?? null) : null
}

/**
 * Allocation that happens on EVERY call, used when following a selector into a
 * helper. Deliberately stricter than isAllocatingExpression: a helper that returns
 * a cached reference on one branch and builds a fresh one on another is the normal
 * identity-caching shape, and flagging it would be a false positive.
 */
function alwaysAllocates(expression) {
  if (expression?.type === 'ConditionalExpression') {
    return alwaysAllocates(expression.consequent) && alwaysAllocates(expression.alternate)
  }
  if (expression?.type === 'LogicalExpression') {
    return alwaysAllocates(expression.left) && alwaysAllocates(expression.right)
  }
  return (
    expression?.type === 'ArrayExpression' ||
    expression?.type === 'ObjectExpression' ||
    expression?.type === 'NewExpression' ||
    (expression?.type === 'CallExpression' &&
      ALLOCATING_METHODS.has(propertyName(expression.callee) ?? ''))
  )
}

/**
 * One hop: a selector that delegates to a module-scope helper is the idiomatic
 * shape here, and neither the inline-body check nor a reviewer reading the call
 * site can see what that helper returns.
 */
function expandThroughNamedHelper(expression, state) {
  if (expression?.type !== 'CallExpression') {
    return [expression]
  }
  const helper = state.namedSelectors.get(identifierName(expression.callee) ?? '')
  if (!helper) {
    return [expression]
  }
  const returned = returnedExpressions(helper)
  return returned.length > 0 && returned.every(alwaysAllocates) ? returned : [expression]
}

function createRuleState() {
  return {
    appStoreHooks: new Set(),
    shallowHooks: new Set(),
    namedSelectors: new Map(),
    deferredCalls: []
  }
}

function recordImports(node, state) {
  if (node.source?.value === 'zustand/react/shallow') {
    for (const specifier of node.specifiers) {
      const localName = importedLocalName(specifier, 'useShallow')
      if (localName) {
        state.shallowHooks.add(localName)
      }
    }
  }
  for (const specifier of node.specifiers) {
    const localName = importedLocalName(specifier, 'useAppStore')
    if (localName) {
      state.appStoreHooks.add(localName)
    }
  }
  if (!isLocalModuleSource(node.source?.value)) {
    return
  }
  for (const specifier of node.specifiers) {
    if (specifier.type !== 'ImportSpecifier') {
      continue
    }
    if (isStoreHookName(identifierName(specifier.imported))) {
      const localName = identifierName(specifier.local)
      if (localName) {
        state.appStoreHooks.add(localName)
      }
    }
  }
}

function isAppStoreCall(node, state) {
  return (
    node.callee.type === 'Identifier' &&
    state.appStoreHooks.has(node.callee.name) &&
    node.optional !== true
  )
}

function requireSelectorRule() {
  const state = createRuleState()
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

/**
 * Selector arguments are collected during traversal and judged at Program:exit so a
 * selector hoisted below its call site still resolves.
 */
function deferredSelectorRule(inspect) {
  const state = createRuleState()
  return {
    ImportDeclaration(node) {
      recordImports(node, state)
    },
    FunctionDeclaration(node) {
      recordNamedSelector(node, state)
    },
    VariableDeclaration(node) {
      recordNamedSelector(node, state)
    },
    CallExpression(node) {
      if (isAppStoreCall(node, state)) {
        state.deferredCalls.push(node)
      }
    },
    'Program:exit'() {
      for (const node of state.deferredCalls) {
        const { selector: argument, shallow } = unwrapShallowSelector(
          node.arguments[0],
          state.shallowHooks
        )
        const report = inspect({
          selector: resolveSelector(argument, state),
          argument,
          shallow,
          node,
          state
        })
        if (report) {
          this.report(report)
        }
      }
    }
  }
}

function noIdentitySelectorRule() {
  return deferredSelectorRule(({ selector }) =>
    isIdentitySelector(selector)
      ? {
          node: selector,
          message:
            'Select the smallest required fields instead of subscribing to the entire app store.'
        }
      : null
  )
}

function noFreshSelectorResultRule() {
  return deferredSelectorRule(({ selector, shallow, state }) => {
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

function noNestedFreshUnderShallowRule() {
  return deferredSelectorRule(({ selector, shallow, state }) => {
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

function bindContext(createVisitors) {
  return (context) => {
    const visitors = createVisitors()
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
    'no-nested-fresh-under-shallow': { create: bindContext(noNestedFreshUnderShallowRule) }
  }
}
