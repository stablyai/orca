// TypeScript 7 is a native CLI; AST consumers still need the legacy JavaScript API.
import ts from 'typescript-api'

const NOTIFICATION_CHANNEL_NAME_NODES = new WeakMap()

function unwrapExpression(node) {
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isNonNullExpression(node)
  ) {
    return unwrapExpression(node.expression)
  }
  return node
}

function expressionNameText(node) {
  if (ts.isIdentifier(node)) {
    return node.text
  }
  if (ts.isPropertyAccessExpression(node)) {
    return `${expressionNameText(node.expression) ?? ''}.${node.name.text}`.replace(/^\./, '')
  }
  return undefined
}

function memberValueExpressions(node, bindings) {
  const expression = unwrapExpression(node)
  if (ts.isPropertyAccessExpression(expression)) {
    return bindings?.valueFlow.propertyValues(expression.expression, expression.name.text, node)
  }
  if (
    ts.isElementAccessExpression(expression) &&
    expression.argumentExpression &&
    ts.isStringLiteralLike(expression.argumentExpression)
  ) {
    return bindings?.valueFlow.propertyValues(
      expression.expression,
      expression.argumentExpression.text,
      node
    )
  }
  return undefined
}

function collectBoundStringNodes(expression, bindings, nodes, seen = new Set()) {
  const resolved = unwrapExpression(expression)
  if (
    ts.isStringLiteralLike(resolved) ||
    ts.isNoSubstitutionTemplateLiteral(resolved) ||
    ts.isTemplateExpression(resolved)
  ) {
    nodes.add(resolved)
    return
  }
  if (ts.isIdentifier(resolved)) {
    const binding = bindings?.resolveBinding(resolved)
    if (!binding || seen.has(binding)) {
      return
    }
    const nextSeen = new Set(seen).add(binding)
    const values = bindings.valueFlow.valueExpressions(resolved, expression, nextSeen)
    values?.forEach((value) => collectBoundStringNodes(value, bindings, nodes, nextSeen))
    return
  }
  const memberValues = memberValueExpressions(resolved, bindings)
  if (memberValues) {
    memberValues.forEach((value) => collectBoundStringNodes(value, bindings, nodes, new Set(seen)))
    return
  }
  if (ts.isConditionalExpression(resolved)) {
    collectBoundStringNodes(resolved.whenTrue, bindings, nodes, new Set(seen))
    collectBoundStringNodes(resolved.whenFalse, bindings, nodes, new Set(seen))
    return
  }
  if (
    ts.isBinaryExpression(resolved) &&
    [
      ts.SyntaxKind.PlusToken,
      ts.SyntaxKind.BarBarToken,
      ts.SyntaxKind.QuestionQuestionToken
    ].includes(resolved.operatorToken.kind)
  ) {
    collectBoundStringNodes(resolved.left, bindings, nodes, new Set(seen))
    collectBoundStringNodes(resolved.right, bindings, nodes, new Set(seen))
  }
}

export function isNotificationChannelName(node, bindings) {
  const sourceFile = node.getSourceFile()
  const cached = NOTIFICATION_CHANNEL_NAME_NODES.get(sourceFile)
  if (cached) {
    return cached.has(node)
  }
  const nodes = new Set()
  function visit(current) {
    if (
      ts.isCallExpression(current) &&
      current.arguments[1] &&
      expressionNameText(current.expression)?.endsWith('setNotificationChannelAsync')
    ) {
      const values = bindings?.valueFlow.propertyValues(current.arguments[1], 'name', current)
      for (const value of values ?? []) {
        collectBoundStringNodes(value, bindings, nodes)
      }
    }
    ts.forEachChild(current, visit)
  }
  visit(sourceFile)
  NOTIFICATION_CHANNEL_NAME_NODES.set(sourceFile, nodes)
  return nodes.has(node)
}
