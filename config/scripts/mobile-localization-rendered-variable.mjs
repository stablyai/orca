// TypeScript 7 is a native CLI; AST consumers still need the legacy JavaScript API.
import ts from 'typescript-api'

import { collectSourceBindings } from './mobile-localization-source-bindings.mjs'
import { createMobileLocalizationValueFlow } from './mobile-localization-value-flow.mjs'

const SOURCE_BINDINGS = new WeakMap()
const SOURCE_IDENTIFIERS = new WeakMap()
const SOURCE_VALUE_FLOWS = new WeakMap()
const RENDERED_FUNCTION_RESULTS = new WeakMap()
const ASSIGNMENT_KINDS = new Set([
  ts.SyntaxKind.EqualsToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken
])

function isDirectDisplayExpressionParent(parent, child) {
  if (
    ts.isParenthesizedExpression(parent) ||
    ts.isAsExpression(parent) ||
    ts.isSatisfiesExpression(parent) ||
    ts.isNonNullExpression(parent)
  ) {
    return parent.expression === child
  }
  if (ts.isConditionalExpression(parent)) {
    return parent.whenTrue === child || parent.whenFalse === child
  }
  if (ts.isBinaryExpression(parent)) {
    return [
      ts.SyntaxKind.PlusToken,
      ts.SyntaxKind.BarBarToken,
      ts.SyntaxKind.QuestionQuestionToken
    ].includes(parent.operatorToken.kind)
  }
  return ts.isTemplateSpan(parent) || ts.isTemplateExpression(parent)
}

export function isRenderedJsxExpression(node) {
  let child = node
  let current = node.parent
  while (current) {
    if (ts.isJsxExpression(current)) {
      return (
        ts.isJsxElement(current.parent) ||
        ts.isJsxFragment(current.parent) ||
        ts.isJsxSelfClosingElement(current.parent)
      )
    }
    if (
      ts.isConditionalExpression(current) ||
      ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isTemplateExpression(current) ||
      ts.isNoSubstitutionTemplateLiteral(current)
    ) {
      if (ts.isConditionalExpression(current) && current.condition === child) {
        return false
      }
      child = current
      current = current.parent
      continue
    }
    if (ts.isBinaryExpression(current)) {
      const operator = current.operatorToken.kind
      if (
        ![
          ts.SyntaxKind.PlusToken,
          ts.SyntaxKind.AmpersandAmpersandToken,
          ts.SyntaxKind.BarBarToken,
          ts.SyntaxKind.QuestionQuestionToken
        ].includes(operator) ||
        (operator !== ts.SyntaxKind.PlusToken && current.left === child)
      ) {
        return false
      }
      child = current
      current = current.parent
      continue
    }
    return false
  }
  return false
}

function memberParts(node) {
  const expression = unwrapAliasExpression(node)
  if (ts.isPropertyAccessExpression(expression)) {
    return { object: expression.expression, propertyName: expression.name.text }
  }
  if (
    ts.isElementAccessExpression(expression) &&
    expression.argumentExpression &&
    ts.isStringLiteralLike(expression.argumentExpression)
  ) {
    return { object: expression.expression, propertyName: expression.argumentExpression.text }
  }
  return undefined
}

function assignedTarget(node) {
  let current = node
  while (current.parent && isDirectDisplayExpressionParent(current.parent, current)) {
    current = current.parent
  }
  const parent = current.parent
  if (
    parent &&
    ts.isVariableDeclaration(parent) &&
    parent.initializer === current &&
    ts.isIdentifier(parent.name)
  ) {
    return parent.name
  }
  return parent &&
    ts.isBinaryExpression(parent) &&
    ASSIGNMENT_KINDS.has(parent.operatorToken.kind) &&
    parent.right === current
    ? unwrapAliasExpression(parent.left)
    : undefined
}

function functionName(node) {
  if (node.name && ts.isIdentifier(node.name)) {
    return node.name.text
  }
  const parent = node.parent
  return (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
    parent &&
    ts.isVariableDeclaration(parent) &&
    ts.isIdentifier(parent.name)
    ? parent.name.text
    : undefined
}

function directReturnFunction(node) {
  let current = node
  while (current.parent && isDirectDisplayExpressionParent(current.parent, current)) {
    current = current.parent
  }
  const parent = current.parent
  if (parent && ts.isReturnStatement(parent) && parent.expression === current) {
    let owner = parent.parent
    while (owner && !ts.isFunctionLike(owner)) {
      owner = owner.parent
    }
    return owner
  }
  return parent && ts.isArrowFunction(parent) && parent.body === current ? parent : undefined
}

export function directReturnFunctionName(node) {
  const owner = directReturnFunction(node)
  return owner ? functionName(owner) : undefined
}

function bindingsFor(sourceFile) {
  const cached = SOURCE_BINDINGS.get(sourceFile)
  if (cached) {
    return cached
  }
  const bindings = collectSourceBindings(sourceFile)
  SOURCE_BINDINGS.set(sourceFile, bindings)
  return bindings
}

function valueFlowFor(sourceFile, bindings) {
  const cached = SOURCE_VALUE_FLOWS.get(sourceFile)
  if (cached) {
    return cached
  }
  const valueFlow = createMobileLocalizationValueFlow(sourceFile, bindings)
  SOURCE_VALUE_FLOWS.set(sourceFile, valueFlow)
  return valueFlow
}

function identifiersFor(sourceFile, name) {
  let byName = SOURCE_IDENTIFIERS.get(sourceFile)
  if (!byName) {
    byName = new Map()
    function visit(node) {
      if (ts.isIdentifier(node)) {
        const matches = byName.get(node.text) ?? []
        matches.push(node)
        byName.set(node.text, matches)
      }
      ts.forEachChild(node, visit)
    }
    visit(sourceFile)
    SOURCE_IDENTIFIERS.set(sourceFile, byName)
  }
  return byName.get(name) ?? []
}

function unwrapAliasExpression(node) {
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isNonNullExpression(node)
  ) {
    return unwrapAliasExpression(node.expression)
  }
  return node
}

function expressionTargetsFunction(node, owner, bindings, valueFlow, seen = new Set()) {
  const expression = unwrapAliasExpression(node)
  if (expression === owner) {
    return true
  }
  if (ts.isIdentifier(expression)) {
    const binding = bindings.resolveBinding(expression)
    if (!binding || seen.has(binding)) {
      return false
    }
    if (binding === owner) {
      return true
    }
    const nextSeen = new Set(seen).add(binding)
    const values = valueFlow.valueExpressions(expression, node, nextSeen)
    return Boolean(
      values?.some((value) =>
        expressionTargetsFunction(value, owner, bindings, valueFlow, nextSeen)
      )
    )
  }
  const member = memberParts(expression)
  if (!member) {
    return false
  }
  if (seen.has(expression)) {
    return false
  }
  const nextSeen = new Set(seen).add(expression)
  const values = valueFlow.propertyValues(member.object, member.propertyName, node)
  return Boolean(
    values?.some((value) => expressionTargetsFunction(value, owner, bindings, valueFlow, nextSeen))
  )
}

export function isReturnedByRenderedFunction(node, isRenderedExpression = isRenderedJsxExpression) {
  const owner = directReturnFunction(node)
  if (!owner) {
    return false
  }
  const cached = RENDERED_FUNCTION_RESULTS.get(owner)?.get(isRenderedExpression)
  if (cached !== undefined) {
    return cached
  }
  const sourceFile = node.getSourceFile()
  const bindings = bindingsFor(sourceFile)
  const valueFlow = valueFlowFor(sourceFile, bindings)
  let rendered = false
  function visit(current) {
    if (rendered) {
      return
    }
    if (
      ts.isCallExpression(current) &&
      expressionTargetsFunction(current.expression, owner, bindings, valueFlow) &&
      isRenderedExpression(current)
    ) {
      rendered = true
      return
    }
    ts.forEachChild(current, visit)
  }
  visit(sourceFile)
  const results = RENDERED_FUNCTION_RESULTS.get(owner) ?? new Map()
  results.set(isRenderedExpression, rendered)
  RENDERED_FUNCTION_RESULTS.set(owner, results)
  return rendered
}

export function renderedVariableAssignmentStatus(
  node,
  isRenderedExpression = isRenderedJsxExpression
) {
  if (ts.isTemplateExpression(node)) {
    return undefined
  }
  const target = assignedTarget(node)
  if (!target) {
    return undefined
  }
  const bindings = bindingsFor(node.getSourceFile())
  const valueFlow = valueFlowFor(node.getSourceFile(), bindings)
  let owner = node.parent
  while (owner && !ts.isFunctionLike(owner) && !ts.isSourceFile(owner)) {
    owner = owner.parent
  }
  if (!owner) {
    return undefined
  }
  const member = memberParts(target)
  if (member) {
    let hasRenderedUse = false
    let reachesRenderedUse = false
    function visit(current) {
      if (reachesRenderedUse) {
        return
      }
      const currentMember = memberParts(current)
      if (currentMember && isRenderedExpression(current)) {
        hasRenderedUse = true
        const values = valueFlow.propertyValues(
          currentMember.object,
          currentMember.propertyName,
          current
        )
        reachesRenderedUse = Boolean(
          values?.some((value) => value.pos <= node.pos && value.end >= node.end)
        )
      }
      ts.forEachChild(current, visit)
    }
    visit(owner)
    return reachesRenderedUse ? 'reaching' : hasRenderedUse ? 'dead' : undefined
  }
  if (!ts.isIdentifier(target)) {
    return undefined
  }
  const targetBinding = bindings.resolveBinding(target)
  if (!targetBinding) {
    return undefined
  }
  let hasRenderedUse = false
  for (const current of identifiersFor(node.getSourceFile(), target.text)) {
    if (
      current.pos < owner.pos ||
      current.end > owner.end ||
      bindings.resolveBinding(current) !== targetBinding ||
      !isRenderedExpression(current)
    ) {
      continue
    }
    hasRenderedUse = true
    const values = valueFlow.valueExpressions(current, current)
    if (values?.some((value) => value.pos <= node.pos && value.end >= node.end)) {
      return 'reaching'
    }
  }
  return hasRenderedUse ? 'dead' : undefined
}

export function isAssignedToRenderedVariable(node, isRenderedExpression = isRenderedJsxExpression) {
  return renderedVariableAssignmentStatus(node, isRenderedExpression) === 'reaching'
}
