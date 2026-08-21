const STYLED_SCROLLBAR_CLASSES = new Set([
  'scrollbar-sleek',
  'scrollbar-editor',
  'worktree-sidebar-scrollbar'
])
const VERTICAL_SCROLL_CLASSES = new Set([
  'overflow-auto',
  'overflow-scroll',
  'overflow-y-auto',
  'overflow-y-scroll'
])
const VERTICAL_SCROLL_STYLE_VALUES = new Set(['auto', 'scroll'])

function withoutImportantModifier(className) {
  const withoutPrefix = className.startsWith('!') ? className.slice(1) : className
  return withoutPrefix.endsWith('!') ? withoutPrefix.slice(0, -1) : withoutPrefix
}

export function plainClassName(token) {
  const normalizedToken = token.startsWith('!') ? token.slice(1) : token
  const parts = []
  let bracketDepth = 0
  let currentPart = ''

  for (const char of normalizedToken) {
    if (char === '[') {
      bracketDepth += 1
    } else if (char === ']') {
      bracketDepth = Math.max(0, bracketDepth - 1)
    }
    if (char === ':' && bracketDepth === 0) {
      parts.push(currentPart)
      currentPart = ''
    } else {
      currentPart += char
    }
  }

  parts.push(currentPart)
  return withoutImportantModifier(parts.at(-1) ?? '')
}

function classTokenParts(token) {
  const variants = []
  let bracketDepth = 0
  let currentPart = ''

  for (const char of token.startsWith('!') ? token.slice(1) : token) {
    if (char === '[') {
      bracketDepth += 1
    } else if (char === ']') {
      bracketDepth = Math.max(0, bracketDepth - 1)
    }
    if (char === ':' && bracketDepth === 0) {
      variants.push(currentPart)
      currentPart = ''
    } else {
      currentPart += char
    }
  }

  return { className: withoutImportantModifier(currentPart), variants: variants.filter(Boolean) }
}

function classTokens(text) {
  return text.split(/\s+/).filter(Boolean).map(classTokenParts)
}

function sameVariants(left, right) {
  return left.length === right.length && left.every((variant, index) => variant === right[index])
}

function literalHasScrollbarForVertical(text, verticalToken) {
  return classTokens(text).some(
    (candidate) =>
      STYLED_SCROLLBAR_CLASSES.has(candidate.className) &&
      (candidate.variants.length === 0 || sameVariants(candidate.variants, verticalToken.variants))
  )
}

function uncoveredVerticalClass(text) {
  return classTokens(text).find(
    (token) =>
      VERTICAL_SCROLL_CLASSES.has(token.className) && !literalHasScrollbarForVertical(text, token)
  )
}

function stringLiteralTexts(node) {
  if (node?.type === 'Literal' && typeof node.value === 'string') {
    return [node.value]
  }
  if (node?.type !== 'TemplateLiteral') {
    return []
  }
  return node.quasis.map((quasi) => quasi.value.cooked ?? quasi.value.raw)
}

function visitChildren(node, visit) {
  for (const [key, child] of Object.entries(node)) {
    if (['parent', 'loc', 'range'].includes(key)) {
      continue
    }
    if (Array.isArray(child)) {
      for (const item of child) {
        if (item?.type) {
          visit(item)
        }
      }
    } else if (child?.type) {
      visit(child)
    }
  }
}

function collectClassLiteralReports(node) {
  const reports = []
  const visit = (current) => {
    for (const text of stringLiteralTexts(current)) {
      const uncovered = uncoveredVerticalClass(text)
      if (uncovered) {
        reports.push({ node: current, detail: uncovered.className })
      }
    }
    visitChildren(current, visit)
  }
  visit(node)
  return reports
}

function expressionHasStyledScrollbarLiteral(node) {
  let found = false
  const visit = (current) => {
    if (found || current.type === 'ConditionalExpression' || current.type === 'LogicalExpression') {
      return
    }
    found = stringLiteralTexts(current).some((text) =>
      classTokens(text).some((token) => STYLED_SCROLLBAR_CLASSES.has(token.className))
    )
    if (!found) {
      visitChildren(current, visit)
    }
  }
  visit(node)
  return found
}

function propertyName(node) {
  if (node?.type !== 'Property') {
    return null
  }
  if (!node.computed && node.key.type === 'Identifier') {
    return node.key.name
  }
  return node.key.type === 'Literal' && typeof node.key.value === 'string' ? node.key.value : null
}

function styleValueIsVerticalScroll(name, value) {
  const parts = value.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (parts.length === 0) {
    return false
  }
  if (name === 'overflowY' || name === 'overflow-y') {
    return VERTICAL_SCROLL_STYLE_VALUES.has(parts[0])
  }
  if (name !== 'overflow') {
    return false
  }
  return VERTICAL_SCROLL_STYLE_VALUES.has(parts.length > 1 ? parts[1] : parts[0])
}

function collectStyleReports(node) {
  const reports = []
  const visit = (current) => {
    if (current.type === 'Property') {
      const name = propertyName(current)
      for (const value of name ? stringLiteralTexts(current.value) : []) {
        if (styleValueIsVerticalScroll(name, value)) {
          reports.push({ node: current, detail: 'inline vertical scroll' })
        }
      }
      visit(current.value)
      return
    }
    visitChildren(current, visit)
  }
  visit(node)
  return reports
}

function unwrapExpression(node) {
  if (
    ['TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression', 'ChainExpression'].includes(
      node?.type
    )
  ) {
    return unwrapExpression(node.expression)
  }
  return node
}

function spreadPropExpressions(expression, propName) {
  const node = unwrapExpression(expression)
  if (!node) {
    return []
  }
  if (node.type === 'ConditionalExpression') {
    return [
      ...spreadPropExpressions(node.consequent, propName),
      ...spreadPropExpressions(node.alternate, propName)
    ]
  }
  if (node.type === 'LogicalExpression' || node.type === 'BinaryExpression') {
    return [
      ...spreadPropExpressions(node.left, propName),
      ...spreadPropExpressions(node.right, propName)
    ]
  }
  if (node.type !== 'ObjectExpression') {
    return []
  }
  return node.properties.flatMap((property) => {
    if (property.type === 'SpreadElement') {
      return spreadPropExpressions(property.argument, propName)
    }
    return propertyName(property) === propName ? [property.value] : []
  })
}

function jsxAttributeExpression(attribute) {
  if (attribute.value?.type === 'Literal') {
    return attribute.value
  }
  return attribute.value?.type === 'JSXExpressionContainer' ? attribute.value.expression : null
}

function jsxElementReports(node) {
  let classExpression = null
  const styleExpressions = []

  for (const attribute of node.attributes) {
    if (attribute.type === 'JSXSpreadAttribute') {
      const spreadClassExpression = spreadPropExpressions(attribute.argument, 'className').at(-1)
      if (spreadClassExpression) {
        classExpression = spreadClassExpression
      }
      styleExpressions.push(...spreadPropExpressions(attribute.argument, 'style'))
    } else if (attribute.name?.name === 'className') {
      classExpression = jsxAttributeExpression(attribute)
    } else if (attribute.name?.name === 'style') {
      const expression = jsxAttributeExpression(attribute)
      if (expression) {
        styleExpressions.push(expression)
      }
    }
  }

  const reports = classExpression ? collectClassLiteralReports(classExpression) : []
  if (!classExpression || !expressionHasStyledScrollbarLiteral(classExpression)) {
    for (const expression of styleExpressions) {
      reports.push(...collectStyleReports(expression))
    }
  }
  return reports
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
  meta: { name: 'renderer-scrollbar-style' },
  rules: {
    'require-styled-vertical-scrollbar': {
      create: bindContext(() => ({
        JSXOpeningElement(node) {
          for (const report of jsxElementReports(node)) {
            this.report({
              node: report.node,
              message: `Vertical scroll container (${report.detail}) must use scrollbar-sleek, scrollbar-editor, or worktree-sidebar-scrollbar.`
            })
          }
        }
      }))
    }
  }
}
