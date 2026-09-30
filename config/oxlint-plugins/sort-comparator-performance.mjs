const FUNCTION_TYPES = new Set([
  'ArrowFunctionExpression',
  'FunctionExpression',
  'FunctionDeclaration'
])

function propertyName(node) {
  if (node?.type !== 'MemberExpression') {
    return null
  }
  if (!node.computed && node.property.type === 'Identifier') {
    return node.property.name
  }
  return node.property.type === 'Literal' ? node.property.value : null
}

function isInlineSortComparator(node) {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (!FUNCTION_TYPES.has(parent.type)) {
      continue
    }
    const call = parent.parent
    return (
      call?.type === 'CallExpression' &&
      call.arguments[0] === parent &&
      ['sort', 'toSorted'].includes(propertyName(call.callee))
    )
  }
  return false
}

function isCollatorConstruction(node) {
  return (
    node.callee?.object?.type === 'Identifier' &&
    node.callee.object.name === 'Intl' &&
    propertyName(node.callee) === 'Collator'
  )
}

function createRule(context) {
  function inspect(node) {
    const optionedComparison =
      node.type === 'CallExpression' &&
      propertyName(node.callee) === 'localeCompare' &&
      node.arguments.length >= 3
    if ((optionedComparison || isCollatorConstruction(node)) && isInlineSortComparator(node)) {
      context.report({
        node,
        message:
          'Create one Intl.Collator before sorting and reuse its compare method; resolving collation options inside the comparator repeats setup for every comparison. Preserve the locale, options, and tie-breaker.'
      })
    }
  }
  return { CallExpression: inspect, NewExpression: inspect }
}

export default {
  meta: { name: 'sort-comparator-performance' },
  rules: { 'no-repeated-collator': { create: createRule } }
}
