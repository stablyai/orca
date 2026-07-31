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

function createRuleState() {
  return {
    appStoreHooks: new Set(),
    shallowHooks: new Set()
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

function noIdentitySelectorRule() {
  const state = createRuleState()
  return {
    ImportDeclaration(node) {
      recordImports(node, state)
    },
    CallExpression(node) {
      if (!isAppStoreCall(node, state)) {
        return
      }
      const { selector } = unwrapShallowSelector(node.arguments[0], state.shallowHooks)
      if (isIdentitySelector(selector)) {
        this.report({
          node: selector,
          message:
            'Select the smallest required fields instead of subscribing to the entire app store.'
        })
      }
    }
  }
}

function noFreshSelectorResultRule() {
  const state = createRuleState()
  return {
    ImportDeclaration(node) {
      recordImports(node, state)
    },
    CallExpression(node) {
      if (!isAppStoreCall(node, state)) {
        return
      }
      const { selector, shallow } = unwrapShallowSelector(node.arguments[0], state.shallowHooks)
      if (shallow) {
        return
      }
      const freshResult = returnedExpressions(selector).find(isAllocatingExpression)
      if (freshResult) {
        this.report({
          node: freshResult,
          message:
            'This selector returns a fresh reference on every store write; select a stable field, cache the result, or use useShallow.'
        })
      }
    }
  }
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
    'no-fresh-selector-result': { create: bindContext(noFreshSelectorResultRule) }
  }
}
