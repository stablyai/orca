// TypeScript 7 is a native CLI; AST consumers still need the legacy JavaScript API.
import ts from 'typescript-api'

const STYLED_SCROLLBAR_CLASSES = new Set(
  'scrollbar-sleek scrollbar-editor worktree-sidebar-scrollbar'.split(' ')
)
// Why: vertical scroll is where native scrollbar drift keeps recurring. The
// guard intentionally ignores horizontal-only overflow.
const VERTICAL_SCROLL_CLASSES = new Set(
  'overflow-auto overflow-scroll overflow-y-auto overflow-y-scroll'.split(' ')
)
const VERTICAL_SCROLL_STYLE_VALUES = new Set(['auto', 'scroll'])

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
      continue
    }
    currentPart += char
  }

  parts.push(currentPart)
  const className = parts.at(-1) ?? ''
  return className.startsWith('!') ? className.slice(1) : className
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
      continue
    }
    currentPart += char
  }

  return { className: plainClassName(token), variants: variants.filter(Boolean) }
}

function classTokens(text) {
  return text.split(/\s+/).filter(Boolean).map(classTokenParts)
}

function sameVariants(left, right) {
  return left.length === right.length && left.every((variant, index) => variant === right[index])
}

function literalHasScrollbarForVertical(text, verticalToken) {
  return classTokens(text).some((candidate) => {
    if (!STYLED_SCROLLBAR_CLASSES.has(candidate.className)) {
      return false
    }
    return (
      candidate.variants.length === 0 || sameVariants(candidate.variants, verticalToken.variants)
    )
  })
}

function uncoveredVerticalClass(text) {
  return classTokens(text).find((token) => {
    return (
      VERTICAL_SCROLL_CLASSES.has(token.className) && !literalHasScrollbarForVertical(text, token)
    )
  })
}

function reportAt(node, filePath, sourceFile, text) {
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
  return {
    filePath,
    line: position.line + 1,
    column: position.character + 1,
    text
  }
}

function stringLiteralTexts(node) {
  if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return [node.text]
  }
  if (!ts.isTemplateExpression(node)) {
    return []
  }
  return [node.head.text, ...node.templateSpans.map((span) => span.literal.text)]
}

function collectClassLiteralReports(node, filePath, sourceFile) {
  const reports = []

  function visit(current) {
    for (const text of stringLiteralTexts(current)) {
      const uncovered = uncoveredVerticalClass(text)
      if (uncovered) {
        reports.push(reportAt(current, filePath, sourceFile, uncovered.className))
      }
    }

    ts.forEachChild(current, visit)
  }

  visit(node)
  return reports
}

function expressionHasStyledScrollbarLiteral(node) {
  let hasStyledScrollbar = false

  function visit(current) {
    if (hasStyledScrollbar) {
      return
    }
    if (
      stringLiteralTexts(current).some((text) =>
        classTokens(text).some((token) => STYLED_SCROLLBAR_CLASSES.has(token.className))
      )
    ) {
      hasStyledScrollbar = true
      return
    }
    // Why: a scrollbar literal that only renders on some branches must not be
    // treated as covering an unconditional inline overflow. Skip conditional
    // and short-circuit expressions when proving unconditional coverage.
    if (ts.isConditionalExpression(current)) {
      return
    }
    if (
      ts.isBinaryExpression(current) &&
      (current.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
        current.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
        current.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
    ) {
      return
    }
    ts.forEachChild(current, visit)
  }

  visit(node)
  return hasStyledScrollbar
}

function propertyNameText(name) {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) {
    return name.text
  }
  if (ts.isComputedPropertyName(name) && ts.isStringLiteralLike(name.expression)) {
    return name.expression.text
  }
  return undefined
}

function styleValueIsVerticalScroll(propertyName, value) {
  const parts = value.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (parts.length === 0) {
    return false
  }
  if (propertyName === 'overflowY' || propertyName === 'overflow-y') {
    return VERTICAL_SCROLL_STYLE_VALUES.has(parts[0])
  }
  if (propertyName !== 'overflow') {
    return false
  }
  const verticalValue = parts.length > 1 ? parts[1] : parts[0]
  return VERTICAL_SCROLL_STYLE_VALUES.has(verticalValue)
}

function collectStyleReports(node, filePath, sourceFile) {
  const reports = []

  function visit(current) {
    if (ts.isPropertyAssignment(current)) {
      const propertyName = propertyNameText(current.name)
      for (const value of propertyName ? stringLiteralTexts(current.initializer) : []) {
        if (styleValueIsVerticalScroll(propertyName, value)) {
          reports.push(reportAt(current, filePath, sourceFile, 'inline vertical scroll'))
        }
      }
      ts.forEachChild(current.initializer, visit)
      return
    }
    ts.forEachChild(current, visit)
  }

  visit(node)
  return reports
}

function jsxAttributeName(attribute) {
  return ts.isIdentifier(attribute.name) ? attribute.name.text : undefined
}

function jsxAttributeExpression(attribute) {
  if (ts.isStringLiteral(attribute.initializer)) {
    return attribute.initializer
  }
  if (attribute.initializer && ts.isJsxExpression(attribute.initializer)) {
    return attribute.initializer.expression
  }
  return undefined
}

function spreadPropExpressions(node, propName) {
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node)
  ) {
    return spreadPropExpressions(node.expression, propName)
  }
  if (ts.isConditionalExpression(node)) {
    return [
      ...spreadPropExpressions(node.whenTrue, propName),
      ...spreadPropExpressions(node.whenFalse, propName)
    ]
  }
  if (ts.isBinaryExpression(node)) {
    return [
      ...spreadPropExpressions(node.left, propName),
      ...spreadPropExpressions(node.right, propName)
    ]
  }
  if (!ts.isObjectLiteralExpression(node)) {
    return []
  }
  return node.properties.flatMap((property) => {
    if (ts.isSpreadAssignment(property)) {
      return spreadPropExpressions(property.expression, propName)
    }
    if (ts.isPropertyAssignment(property) && propertyNameText(property.name) === propName) {
      return [property.initializer]
    }
    return []
  })
}

function jsxElementReports(node, filePath, sourceFile) {
  const reports = []
  let classExpression
  const styleExpressions = []

  for (const attribute of node.attributes.properties) {
    if (ts.isJsxSpreadAttribute(attribute)) {
      // Why: at runtime React applies attributes in source order, so a later
      // spread that supplies className overrides an earlier explicit className.
      const spreadClassExpression = spreadPropExpressions(attribute.expression, 'className').at(-1)
      if (spreadClassExpression) {
        classExpression = spreadClassExpression
      }
      styleExpressions.push(...spreadPropExpressions(attribute.expression, 'style'))
    } else if (jsxAttributeName(attribute) === 'className') {
      classExpression = jsxAttributeExpression(attribute)
    } else if (jsxAttributeName(attribute) === 'style') {
      const expression = jsxAttributeExpression(attribute)
      if (expression) {
        styleExpressions.push(expression)
      }
    }
  }

  if (classExpression) {
    reports.push(...collectClassLiteralReports(classExpression, filePath, sourceFile))
  }
  if (classExpression && expressionHasStyledScrollbarLiteral(classExpression)) {
    return reports
  }
  for (const expression of styleExpressions) {
    reports.push(...collectStyleReports(expression, filePath, sourceFile))
  }
  return reports
}

export function reportUnstyledScrollbars(filePath, sourceText) {
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  )
  const reports = []

  function visit(node) {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      reports.push(...jsxElementReports(node, filePath, sourceFile))
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return reports
}
