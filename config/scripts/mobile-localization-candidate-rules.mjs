// TypeScript 7 is a native CLI; AST consumers still need the legacy JavaScript API.
import ts from 'typescript-api'

import {
  directReturnFunctionName,
  isAssignedToRenderedVariable,
  isRenderedJsxExpression,
  isReturnedByRenderedFunction,
  renderedVariableAssignmentStatus
} from './mobile-localization-rendered-variable.mjs'
import { isNotificationChannelName } from './mobile-localization-notification-channel.mjs'

const USER_VISIBLE_JSX_ATTRIBUTES = new Set([
  'ariaLabel',
  'aria-label',
  'aria-description',
  'accessibilityHint',
  'accessibilityLabel',
  'alt',
  'description',
  'emptyText',
  'helperText',
  'keywords',
  'label',
  'message',
  'placeholder',
  'subtitle',
  'text',
  'title',
  'toggleDescription',
  'tooltip'
])
const USER_VISIBLE_OBJECT_KEYS = new Set([
  'ariaLabel',
  'accessibilityHint',
  'accessibilityLabel',
  'badge',
  'description',
  'emptyText',
  'error',
  'helperText',
  'keywords',
  'label',
  'message',
  'placeholder',
  'subject',
  'subtitle',
  'successToast',
  'title',
  'toggleDescription',
  'tooltip'
])
const MOBILE_USER_VISIBLE_JSX_ATTRIBUTES = new Set(['fallback'])
const MOBILE_USER_VISIBLE_OBJECT_KEYS = new Set([
  'desc',
  'detail',
  'hint',
  'instructions',
  'question'
])
const MOBILE_USER_VISIBLE_PROPERTY_SUFFIX_RE =
  /(?:Caption|Description|Heading|Hint|Label|Message|Notice|Placeholder|Subtitle|Summary|Text|Title|Tooltip|Warning)$/
const USER_VISIBLE_COLLECTION_SUFFIX_RE =
  /(?:Captions|Descriptions|Headings|Hints|Labels|Messages|Notices|Placeholders|Subtitles|Summaries|Text|Titles|Tooltips|Warnings)$|_(?:CAPTIONS|DESCRIPTIONS|HEADINGS|HINTS|LABELS|MESSAGES|NOTICES|PLACEHOLDERS|SUBTITLES|SUMMARIES|TEXT|TITLES|TOOLTIPS|WARNINGS)$/
const MOBILE_USER_VISIBLE_CALL_ARGUMENTS = new Map([
  ['assertRpcOk', new Set([1])],
  ['browserErrorMessage', new Set([1])],
  ['failureState', new Set([0])],
  ['onError', new Set([0])],
  ['onFailure', new Set([0])],
  ['onSendError', new Set([0])],
  ['onToast', new Set([0])],
  ['previewError', new Set([0])],
  ['reportEngineError', new Set([0])],
  ['reportNativeEngineError', new Set([0])],
  ['sendMobileHostedReviewGitMutation', new Set([3])]
])
const USER_VISIBLE_FUNCTION_NAMES = new Set([
  'alert',
  'confirm',
  'prompt',
  'showError',
  'showToast'
])
const USER_VISIBLE_OBJECT_METHODS = new Set([
  'error',
  'info',
  'loading',
  'message',
  'promise',
  'success',
  'warning'
])
const USER_VISIBLE_OBJECT_NAMES = new Set(['toast'])
const USER_VISIBLE_VARIABLE_NAMES = new Set([
  'caption',
  'description',
  'detail',
  'emptyLabel',
  'error',
  'explanation',
  'heading',
  'hint',
  'label',
  'message',
  'notice',
  'placeholder',
  'statusText',
  'subtitle',
  'summary',
  'text',
  'title',
  'warning'
])
const USER_VISIBLE_VARIABLE_SUFFIX_RE =
  /(?:Caption|Description|EmptyLabel|Error|Explanation|Heading|Hint|Label|Message|Notice|Placeholder|StatusText|Subtitle|Summary|Title|Warning)$|_(?:CAPTION|DESCRIPTION|EMPTY_LABEL|ERROR|EXPLANATION|HEADING|HINT|LABEL|MESSAGE|NOTICE|PLACEHOLDER|STATUS_TEXT|SUBTITLE|SUMMARY|TITLE|WARNING)$/
const USER_VISIBLE_RETURN_FUNCTIONS = new Set([
  'accessibilityLabelForLine',
  'autoRestoreSummary',
  'commentAuthor',
  'commentSourceLabel',
  'composerLabel',
  'describeScope',
  'discussionSummary',
  'formatAgo',
  'formatBranchLabel',
  'formatCommitTime',
  'formatDurationSeconds',
  'formatMobileHostedReviewCreateError',
  'formatPrCommentRelativeTime',
  'formatTimeAgo',
  'formatUpdatedAt',
  'getGitHubChecksLabel',
  'getGitHubMergeLabel',
  'getHostedMergeConfirmMessage',
  'getHostedReviewMergeMethodLabel',
  'getHostedStateConfirmLabel',
  'getHostedStateConfirmMessage',
  'getHostedStateConfirmTitle',
  'getMobileSessionTabTitle',
  'getProjectGitHubMergeConfirmMessage',
  'getPrComposeDisabledReason',
  'getWorktreeLabel',
  'gitHubStatusLabel',
  'gitLabStatusLabel',
  'gitLabTodoTargetLabel',
  'hostedReviewMergeTargetLabel',
  'labelForEmpty',
  'mobileAiVaultResumeTargetBlockMessage',
  'mobileConflictAbortLabel',
  'mobileConnectionPathLabel',
  'mobileReviewScopeLabel',
  'projectFieldValueLabel',
  'projectRowStatusLabel',
  'repositoryCount',
  'saveErrorMessageFromPreviewResult',
  'sendSheetMessage',
  'setupSourceLabel',
  'taskExternalOpenLabel',
  'taskKindLabel',
  'taskStatusActionLabel',
  'workspaceAgentLabel',
  'workspaceSshStatusLabel'
])

function propertyNameText(name) {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) {
    return name.text
  }
  if (ts.isComputedPropertyName(name) && ts.isStringLiteralLike(name.expression)) {
    return name.expression.text
  }
  return undefined
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

function findAncestor(node, predicate) {
  let current = node.parent
  while (current) {
    if (predicate(current)) {
      return current
    }
    current = current.parent
  }
  return undefined
}

function isJsxAttributeValue(node) {
  const parent = node.parent
  if (!parent) {
    return undefined
  }
  if (ts.isJsxAttribute(parent)) {
    return propertyNameText(parent.name)
  }
  if (parent && ts.isJsxExpression(parent) && parent.parent && ts.isJsxAttribute(parent.parent)) {
    return propertyNameText(parent.parent.name)
  }
  return undefined
}

function ancestorJsxAttributeName(node) {
  let current = node.parent
  while (current) {
    if (ts.isJsxAttribute(current)) {
      return propertyNameText(current.name)
    }
    if (
      ts.isJsxExpression(current) ||
      ts.isConditionalExpression(current) ||
      ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isBinaryExpression(current)
    ) {
      current = current.parent
      continue
    }
    return undefined
  }
  return undefined
}

function nearestObjectPropertyName(node) {
  let current = node.parent
  while (current) {
    if (ts.isPropertyAssignment(current) || ts.isShorthandPropertyAssignment(current)) {
      return propertyNameText(current.name)
    }
    if (ts.isObjectLiteralExpression(current) || ts.isArrayLiteralExpression(current)) {
      current = current.parent
      continue
    }
    return undefined
  }
  return undefined
}

function nearestAncestorObjectPropertyName(node) {
  let current = node.parent
  while (current) {
    if (ts.isPropertyAssignment(current) || ts.isShorthandPropertyAssignment(current)) {
      return propertyNameText(current.name)
    }
    current = current.parent
  }
  return undefined
}

function hasAncestorObjectPropertyName(node, names) {
  let current = node.parent
  while (current) {
    if (
      (ts.isPropertyAssignment(current) || ts.isShorthandPropertyAssignment(current)) &&
      names.has(propertyNameText(current.name) ?? '')
    ) {
      return true
    }
    current = current.parent
  }
  return false
}

function isDirectDisplayExpressionParent(parent, child) {
  if (
    ts.isParenthesizedExpression(parent) ||
    ts.isAsExpression(parent) ||
    ts.isSatisfiesExpression(parent)
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

function directDisplayVariableName(node) {
  let current = node
  while (current.parent && isDirectDisplayExpressionParent(current.parent, current)) {
    current = current.parent
  }
  const declaration = current.parent
  if (
    declaration &&
    (ts.isVariableDeclaration(declaration) ||
      ts.isBindingElement(declaration) ||
      ts.isParameter(declaration)) &&
    declaration.initializer === current &&
    ts.isIdentifier(declaration.name)
  ) {
    return declaration.name.text
  }
  return undefined
}

function isUserVisibleVariableValue(node) {
  const name = directDisplayVariableName(node)
  return Boolean(
    name && (USER_VISIBLE_VARIABLE_NAMES.has(name) || USER_VISIBLE_VARIABLE_SUFFIX_RE.test(name))
  )
}

function directDisplayCollectionName(node) {
  let current = node
  while (current.parent) {
    if (isDirectDisplayExpressionParent(current.parent, current)) {
      current = current.parent
      continue
    }
    if (
      (ts.isPropertyAssignment(current.parent) && current.parent.initializer === current) ||
      ts.isObjectLiteralExpression(current.parent) ||
      ts.isArrayLiteralExpression(current.parent)
    ) {
      current = current.parent
      continue
    }
    break
  }
  const declaration = current.parent
  return declaration &&
    ts.isVariableDeclaration(declaration) &&
    declaration.initializer === current &&
    ts.isIdentifier(declaration.name)
    ? declaration.name.text
    : undefined
}

function isDisplayFormatterArgument(node) {
  const call = findAncestor(node, ts.isCallExpression)
  const name = call ? expressionNameText(call.expression)?.split('.').at(-1) : undefined
  return Boolean(name && USER_VISIBLE_RETURN_FUNCTIONS.has(name))
}

function directCallArgumentIndex(call, node) {
  let current = node
  while (current.parent && current.parent !== call) {
    if (!isDirectDisplayExpressionParent(current.parent, current)) {
      return -1
    }
    current = current.parent
  }
  return call.arguments.indexOf(current)
}

function isUserVisibleCallArgument(node, userVisibleErrorSource) {
  const call = findAncestor(node, ts.isCallExpression)
  const expressionName = call ? expressionNameText(call.expression) : undefined
  if (!call || !expressionName) {
    return false
  }
  const parts = expressionName.split('.')
  const methodName = parts.at(-1) ?? ''
  const objectName = parts.at(-2)
  const mobileArgumentIndexes = MOBILE_USER_VISIBLE_CALL_ARGUMENTS.get(methodName)
  return (
    (userVisibleErrorSource && expressionName === 'Error') ||
    mobileArgumentIndexes?.has(directCallArgumentIndex(call, node)) ||
    /^set[A-Za-z0-9]*(Error|Message|Notice|Warning)$/.test(methodName) ||
    USER_VISIBLE_FUNCTION_NAMES.has(expressionName) ||
    USER_VISIBLE_FUNCTION_NAMES.has(methodName) ||
    (objectName !== undefined &&
      USER_VISIBLE_OBJECT_NAMES.has(objectName) &&
      USER_VISIBLE_OBJECT_METHODS.has(methodName))
  )
}

function isUserVisibleErrorArgument(node, userVisibleErrorSource) {
  if (!userVisibleErrorSource) {
    return false
  }
  const expression = findAncestor(node, ts.isNewExpression)
  return Boolean(
    expression && ts.isIdentifier(expression.expression) && expression.expression.text === 'Error'
  )
}

function isRenderedMobileExpression(expression) {
  return isRenderedJsxExpression(expression) || isAssignedToRenderedVariable(expression)
}

function hasDisqualifyingBinaryAncestor(node) {
  let current = node.parent
  while (current) {
    if (ts.isFunctionLike(current)) {
      return false
    }
    if (
      ts.isBinaryExpression(current) &&
      ![
        ts.SyntaxKind.PlusToken,
        ts.SyntaxKind.AmpersandAmpersandToken,
        ts.SyntaxKind.BarBarToken,
        ts.SyntaxKind.QuestionQuestionToken
      ].includes(current.operatorToken.kind)
    ) {
      return true
    }
    current = current.parent
  }
  return false
}

function isComparisonOperand(node) {
  let current = node
  while (
    current.parent &&
    (ts.isParenthesizedExpression(current.parent) ||
      ts.isAsExpression(current.parent) ||
      ts.isSatisfiesExpression(current.parent))
  ) {
    current = current.parent
  }
  return Boolean(
    current.parent &&
    ts.isBinaryExpression(current.parent) &&
    ![
      ts.SyntaxKind.PlusToken,
      ts.SyntaxKind.AmpersandAmpersandToken,
      ts.SyntaxKind.BarBarToken,
      ts.SyntaxKind.QuestionQuestionToken
    ].includes(current.parent.operatorToken.kind)
  )
}

export function classifyMobileStringNode(node, userVisibleErrorSource, bindings) {
  if (hasAncestorObjectPropertyName(node, new Set(['className', 'classNames']))) {
    return undefined
  }
  const renderedVariableStatus = renderedVariableAssignmentStatus(node, (expression) => {
    if (isRenderedJsxExpression(expression)) {
      return true
    }
    if (isComparisonOperand(expression)) {
      return false
    }
    const attributeName = ancestorJsxAttributeName(expression)
    return Boolean(
      attributeName &&
      (USER_VISIBLE_JSX_ATTRIBUTES.has(attributeName) ||
        MOBILE_USER_VISIBLE_JSX_ATTRIBUTES.has(attributeName) ||
        MOBILE_USER_VISIBLE_PROPERTY_SUFFIX_RE.test(attributeName))
    )
  })
  if (renderedVariableStatus === 'reaching') {
    return 'rendered-variable'
  }
  if (isNotificationChannelName(node, bindings)) {
    return 'notification-channel-name'
  }
  if (isComparisonOperand(node)) {
    return undefined
  }

  const jsxAttributeName = isJsxAttributeValue(node)
  if (jsxAttributeName) {
    return USER_VISIBLE_JSX_ATTRIBUTES.has(jsxAttributeName) ||
      MOBILE_USER_VISIBLE_JSX_ATTRIBUTES.has(jsxAttributeName) ||
      MOBILE_USER_VISIBLE_PROPERTY_SUFFIX_RE.test(jsxAttributeName)
      ? `jsx-attribute:${jsxAttributeName}`
      : undefined
  }
  const ancestorAttributeName = ancestorJsxAttributeName(node)
  if (ancestorAttributeName) {
    return USER_VISIBLE_JSX_ATTRIBUTES.has(ancestorAttributeName) ||
      MOBILE_USER_VISIBLE_JSX_ATTRIBUTES.has(ancestorAttributeName) ||
      MOBILE_USER_VISIBLE_PROPERTY_SUFFIX_RE.test(ancestorAttributeName)
      ? `jsx-attribute:${ancestorAttributeName}`
      : undefined
  }
  if (ts.isJsxText(node)) {
    return 'jsx-text'
  }

  const returnFunctionName = directReturnFunctionName(node)
  if (isReturnedByRenderedFunction(node, isRenderedMobileExpression)) {
    return 'rendered-function-return'
  }

  const objectPropertyName = nearestObjectPropertyName(node)
  const userVisibleObjectProperty =
    objectPropertyName &&
    (USER_VISIBLE_OBJECT_KEYS.has(objectPropertyName) ||
      MOBILE_USER_VISIBLE_OBJECT_KEYS.has(objectPropertyName) ||
      MOBILE_USER_VISIBLE_PROPERTY_SUFFIX_RE.test(objectPropertyName))
  if (
    isUserVisibleCallArgument(node, userVisibleErrorSource) &&
    (!objectPropertyName || objectPropertyName === 'text' || userVisibleObjectProperty)
  ) {
    return 'user-visible-call'
  }
  const collectionName = directDisplayCollectionName(node)
  if (collectionName && USER_VISIBLE_COLLECTION_SUFFIX_RE.test(collectionName)) {
    return 'user-visible-collection'
  }
  if (objectPropertyName && !userVisibleObjectProperty) {
    return undefined
  }
  if (isDisplayFormatterArgument(node)) {
    return undefined
  }

  const ancestorObjectPropertyName = nearestAncestorObjectPropertyName(node)
  if (
    ancestorObjectPropertyName &&
    !USER_VISIBLE_OBJECT_KEYS.has(ancestorObjectPropertyName) &&
    !MOBILE_USER_VISIBLE_OBJECT_KEYS.has(ancestorObjectPropertyName) &&
    !MOBILE_USER_VISIBLE_PROPERTY_SUFFIX_RE.test(ancestorObjectPropertyName)
  ) {
    return undefined
  }
  if (ancestorObjectPropertyName) {
    return `object-property:${ancestorObjectPropertyName}`
  }
  if (hasDisqualifyingBinaryAncestor(node)) {
    return undefined
  }
  if (renderedVariableStatus !== 'dead' && isUserVisibleVariableValue(node)) {
    return 'user-visible-variable'
  }
  if (
    returnFunctionName &&
    (USER_VISIBLE_RETURN_FUNCTIONS.has(returnFunctionName) ||
      USER_VISIBLE_VARIABLE_SUFFIX_RE.test(returnFunctionName))
  ) {
    return 'user-visible-return'
  }
  if (isUserVisibleErrorArgument(node, userVisibleErrorSource)) {
    return 'user-visible-error'
  }
  if (isRenderedJsxExpression(node)) {
    return 'jsx-expression'
  }
  if (isUserVisibleCallArgument(node, userVisibleErrorSource)) {
    return 'user-visible-call'
  }
  return objectPropertyName ? `object-property:${objectPropertyName}` : undefined
}
