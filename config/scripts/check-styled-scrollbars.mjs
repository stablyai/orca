import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import process from 'node:process'
import ts from 'typescript'

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts'])
const SKIP_PATH_PARTS = new Set(['node_modules', 'dist', 'out', '.git', '__snapshots__'])
const STYLED_SCROLLBAR_CLASSES = new Set([
  'scrollbar-sleek',
  'scrollbar-editor',
  'worktree-sidebar-scrollbar'
])
// Why: vertical scrolling is where Orca's native scrollbar drift keeps showing
// up in cards, dialogs, and menus; horizontal code/table overflow is handled separately.
const VERTICAL_SCROLL_CLASSES = new Set([
  'overflow-auto',
  'overflow-scroll',
  'overflow-y-auto',
  'overflow-y-scroll',
  'inline-vertical-scroll'
])
const CLASS_COMPOSER_FUNCTIONS = new Set([
  'cn',
  'clsx',
  'classNames',
  'classnames',
  'twJoin',
  'twMerge'
])
const CLASS_CHAIN_RECEIVER_METHODS = new Set(['flat', 'join'])
const CLASS_CHAIN_RECEIVER_AND_ARGUMENT_METHODS = new Set(['concat'])
const CLASS_CONFIG_PROPERTIES = new Set(['class', 'className', 'classes'])
const CLASS_HELPER_NAME_PATTERN = /(?:class|classes|variant|variants|cva|style|styles)/i
const NON_CLASS_METHOD_CALLS = new Set([
  'endsWith',
  'every',
  'findIndex',
  'includes',
  'indexOf',
  'match',
  'some',
  'startsWith',
  'test'
])
const EQUALITY_OPERATORS = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken
])
// Why: `??` and `||` diverge for non-nullish falsy class values, so
// scrollbar coverage needs a small value lattice instead of boolean atoms.
const NULLISH_CONDITION_PREFIX = 'nullish:'
const VARIANT_CONDITION_PREFIX = 'variant:'
const CONDITION_STATES = ['nullish', 'falsy', 'truthy']
const VERTICAL_SCROLL_STYLE_VALUES = new Set(['auto', 'scroll'])

export function normalizePath(root, filePath) {
  return path.relative(root, filePath).split(path.sep).join('/')
}

function isSkippedFile(root, filePath) {
  const relative = normalizePath(root, filePath)
  if (relative.includes('.test.') || relative.includes('.spec.')) {
    return true
  }
  return relative.split('/').some((part) => SKIP_PATH_PARTS.has(part))
}

async function collectSourceFiles(root, dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  const files = []

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!SKIP_PATH_PARTS.has(entry.name)) {
        files.push(...(await collectSourceFiles(root, fullPath)))
      }
      continue
    }
    if (!entry.isFile() || isSkippedFile(root, fullPath)) {
      continue
    }
    if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(fullPath)
    }
  }

  return files
}

export function plainClassName(token) {
  return classTokenParts(token).className
}

function classTokenParts(token) {
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
  const className = parts.pop() ?? ''
  return {
    className: className.startsWith('!') ? className.slice(1) : className,
    variants: parts.filter(Boolean)
  }
}

function classTokens(text) {
  return text.split(/\s+/).filter(Boolean)
}

function variantAtom(variant) {
  return `${VARIANT_CONDITION_PREFIX}${variant}`
}

function lineAndColumnForPosition(sourceText, position) {
  let line = 1
  let lineStart = 0
  for (let index = 0; index < position; index += 1) {
    if (sourceText.charCodeAt(index) === 10) {
      line += 1
      lineStart = index + 1
    }
  }
  return { line, column: position - lineStart + 1 }
}

function stringFragments(node) {
  if (ts.isStringLiteralLike(node)) {
    return [node.text]
  }
  if (!ts.isTemplateExpression(node)) {
    return []
  }
  return [node.head.text, ...node.templateSpans.map((span) => span.literal.text)]
}

function booleanLiteralValue(node) {
  if (node.kind === ts.SyntaxKind.TrueKeyword) {
    return true
  }
  if (node.kind === ts.SyntaxKind.FalseKeyword) {
    return false
  }
  return undefined
}

function truthyLiteralValue(node) {
  const booleanValue = booleanLiteralValue(node)
  if (booleanValue !== undefined) {
    return booleanValue
  }
  if (node.kind === ts.SyntaxKind.NullKeyword) {
    return false
  }
  if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text.length > 0
  }
  if (ts.isNumericLiteral(node)) {
    return Number(node.text) !== 0
  }
  return undefined
}

function nullishLiteralValue(node) {
  if (node.kind === ts.SyntaxKind.NullKeyword) {
    return true
  }
  if (
    node.kind === ts.SyntaxKind.TrueKeyword ||
    node.kind === ts.SyntaxKind.FalseKeyword ||
    ts.isStringLiteralLike(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    ts.isNumericLiteral(node)
  ) {
    return false
  }
  return undefined
}

function normalizedExpression(node, sourceFile) {
  return node.getText(sourceFile).replace(/\s+/g, '')
}

function equalityConditionAtom(node, sourceFile) {
  if (!ts.isBinaryExpression(node) || !EQUALITY_OPERATORS.has(node.operatorToken.kind)) {
    return undefined
  }

  const operands = [
    normalizedExpression(node.left, sourceFile),
    normalizedExpression(node.right, sourceFile)
  ].sort()
  const atom = `equals:${operands[0]}:${operands[1]}`
  if (
    node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
    node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsToken
  ) {
    return inverseAtom(atom)
  }
  return atom
}

function nullishAtom(node, sourceFile) {
  return `${NULLISH_CONDITION_PREFIX}${normalizedExpression(node, sourceFile)}`
}

function inverseAtom(atom) {
  return atom.startsWith('!') ? atom.slice(1) : `!${atom}`
}

function parsedAtom(atom) {
  const value = !atom.startsWith('!')
  const positiveAtom = value ? atom : atom.slice(1)
  if (positiveAtom.startsWith(NULLISH_CONDITION_PREFIX)) {
    return {
      expression: positiveAtom.slice(NULLISH_CONDITION_PREFIX.length),
      kind: 'nullish',
      value
    }
  }
  return { expression: positiveAtom, kind: 'truthy', value }
}

function atomImplies(left, right) {
  const leftAtom = parsedAtom(left)
  const rightAtom = parsedAtom(right)
  if (leftAtom.expression !== rightAtom.expression) {
    return false
  }
  if (leftAtom.kind === rightAtom.kind) {
    return leftAtom.value === rightAtom.value
  }

  if (
    leftAtom.kind === 'truthy' &&
    leftAtom.value === true &&
    rightAtom.kind === 'nullish' &&
    rightAtom.value === false
  ) {
    return true
  }

  return (
    leftAtom.kind === 'nullish' &&
    leftAtom.value === true &&
    rightAtom.kind === 'truthy' &&
    rightAtom.value === false
  )
}

function atomsConflict(left, right) {
  return atomImplies(left, inverseAtom(right)) || atomImplies(right, inverseAtom(left))
}

function combineConditions(left, right) {
  if (!left || !right) {
    return undefined
  }

  const combined = [...left]
  for (const atom of right) {
    if (combined.some((existingAtom) => atomsConflict(existingAtom, atom))) {
      return undefined
    }
    if (combined.some((existingAtom) => atomImplies(existingAtom, atom))) {
      continue
    }
    for (let index = combined.length - 1; index >= 0; index -= 1) {
      if (atomImplies(atom, combined[index])) {
        combined.splice(index, 1)
      }
    }
    combined.push(atom)
  }
  return combined
}

function combineConditionBranches(leftBranches, rightBranches) {
  const combinedBranches = []
  for (const left of leftBranches) {
    for (const right of rightBranches) {
      const combined = combineConditions(left, right)
      if (combined) {
        combinedBranches.push(combined)
      }
    }
  }
  return combinedBranches
}

function conditionBranchesForTruthy(node, sourceFile) {
  const literalValue = truthyLiteralValue(node)
  if (literalValue === true) {
    return [[]]
  }
  if (literalValue === false) {
    return []
  }

  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node)
  ) {
    return conditionBranchesForTruthy(node.expression, sourceFile)
  }

  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) {
    return conditionBranchesForFalsy(node.operand, sourceFile)
  }

  const equalityAtom = equalityConditionAtom(node, sourceFile)
  if (equalityAtom) {
    return [[equalityAtom]]
  }

  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
  ) {
    return combineConditionBranches(
      conditionBranchesForTruthy(node.left, sourceFile),
      conditionBranchesForTruthy(node.right, sourceFile)
    )
  }

  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
    return [
      ...conditionBranchesForTruthy(node.left, sourceFile),
      ...combineConditionBranches(
        conditionBranchesForFalsy(node.left, sourceFile),
        conditionBranchesForTruthy(node.right, sourceFile)
      )
    ]
  }

  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
  ) {
    return [
      ...conditionBranchesForTruthy(node.left, sourceFile),
      ...combineConditionBranches(
        conditionBranchesForNullish(node.left, sourceFile),
        conditionBranchesForTruthy(node.right, sourceFile)
      )
    ]
  }

  return [[normalizedExpression(node, sourceFile)]]
}

function conditionBranchesForFalsy(node, sourceFile) {
  const literalValue = truthyLiteralValue(node)
  if (literalValue === true) {
    return []
  }
  if (literalValue === false) {
    return [[]]
  }

  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node)
  ) {
    return conditionBranchesForFalsy(node.expression, sourceFile)
  }

  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) {
    return conditionBranchesForTruthy(node.operand, sourceFile)
  }

  const equalityAtom = equalityConditionAtom(node, sourceFile)
  if (equalityAtom) {
    return [[inverseAtom(equalityAtom)]]
  }

  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
  ) {
    return [
      ...conditionBranchesForFalsy(node.left, sourceFile),
      ...combineConditionBranches(
        conditionBranchesForTruthy(node.left, sourceFile),
        conditionBranchesForFalsy(node.right, sourceFile)
      )
    ]
  }

  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
    return combineConditionBranches(
      conditionBranchesForFalsy(node.left, sourceFile),
      conditionBranchesForFalsy(node.right, sourceFile)
    )
  }

  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
  ) {
    return [
      ...combineConditionBranches(
        conditionBranchesForNonNullish(node.left, sourceFile),
        conditionBranchesForFalsy(node.left, sourceFile)
      ),
      ...combineConditionBranches(
        conditionBranchesForNullish(node.left, sourceFile),
        conditionBranchesForFalsy(node.right, sourceFile)
      )
    ]
  }

  return [[`!${normalizedExpression(node, sourceFile)}`]]
}

function conditionBranchesForNullish(node, sourceFile) {
  const literalValue = nullishLiteralValue(node)
  if (literalValue === true) {
    return [[]]
  }
  if (literalValue === false) {
    return []
  }

  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node)
  ) {
    return conditionBranchesForNullish(node.expression, sourceFile)
  }

  if (ts.isConditionalExpression(node)) {
    return [
      ...combineConditionBranches(
        conditionBranchesForTruthy(node.condition, sourceFile),
        conditionBranchesForNullish(node.whenTrue, sourceFile)
      ),
      ...combineConditionBranches(
        conditionBranchesForFalsy(node.condition, sourceFile),
        conditionBranchesForNullish(node.whenFalse, sourceFile)
      )
    ]
  }

  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
  ) {
    return [
      ...conditionBranchesForNullish(node.left, sourceFile),
      ...combineConditionBranches(
        conditionBranchesForTruthy(node.left, sourceFile),
        conditionBranchesForNullish(node.right, sourceFile)
      )
    ]
  }

  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
    return combineConditionBranches(
      conditionBranchesForFalsy(node.left, sourceFile),
      conditionBranchesForNullish(node.right, sourceFile)
    )
  }

  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
  ) {
    return combineConditionBranches(
      conditionBranchesForNullish(node.left, sourceFile),
      conditionBranchesForNullish(node.right, sourceFile)
    )
  }

  return [[nullishAtom(node, sourceFile)]]
}

function conditionBranchesForNonNullish(node, sourceFile) {
  const literalValue = nullishLiteralValue(node)
  if (literalValue === true) {
    return []
  }
  if (literalValue === false) {
    return [[]]
  }

  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node)
  ) {
    return conditionBranchesForNonNullish(node.expression, sourceFile)
  }

  if (ts.isConditionalExpression(node)) {
    return [
      ...combineConditionBranches(
        conditionBranchesForTruthy(node.condition, sourceFile),
        conditionBranchesForNonNullish(node.whenTrue, sourceFile)
      ),
      ...combineConditionBranches(
        conditionBranchesForFalsy(node.condition, sourceFile),
        conditionBranchesForNonNullish(node.whenFalse, sourceFile)
      )
    ]
  }

  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
  ) {
    return [
      ...combineConditionBranches(
        conditionBranchesForFalsy(node.left, sourceFile),
        conditionBranchesForNonNullish(node.left, sourceFile)
      ),
      ...combineConditionBranches(
        conditionBranchesForTruthy(node.left, sourceFile),
        conditionBranchesForNonNullish(node.right, sourceFile)
      )
    ]
  }

  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
    return [
      ...conditionBranchesForTruthy(node.left, sourceFile),
      ...combineConditionBranches(
        conditionBranchesForFalsy(node.left, sourceFile),
        conditionBranchesForNonNullish(node.right, sourceFile)
      )
    ]
  }

  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
  ) {
    return [
      ...conditionBranchesForNonNullish(node.left, sourceFile),
      ...combineConditionBranches(
        conditionBranchesForNullish(node.left, sourceFile),
        conditionBranchesForNonNullish(node.right, sourceFile)
      )
    ]
  }

  return [[inverseAtom(nullishAtom(node, sourceFile))]]
}

function applyConditions(terms, conditionBranches) {
  if (conditionBranches.length === 0) {
    return []
  }
  return terms.flatMap((term) => {
    return conditionBranches.flatMap((condition) => {
      const combined = combineConditions(term.condition, condition)
      return combined ? [{ ...term, condition: combined }] : []
    })
  })
}

function complementConditionBranches(condition) {
  if (condition.length === 0) {
    return []
  }

  const branches = []
  const previousAtoms = []
  for (const atom of condition) {
    branches.push([...previousAtoms, inverseAtom(atom)])
    previousAtoms.push(atom)
  }
  return branches
}

function termsOutsideCondition(term, condition) {
  return complementConditionBranches(condition).flatMap((branch) => {
    const remainingCondition = combineConditions(term.condition, branch)
    return remainingCondition ? [{ ...term, condition: remainingCondition }] : []
  })
}

function removeOverwrittenTerms(terms, text, condition = []) {
  for (let index = terms.length - 1; index >= 0; index -= 1) {
    if (terms[index].overwrites && terms[index].text === text) {
      terms.splice(index, 1, ...termsOutsideCondition(terms[index], condition))
    }
  }
}

function appendClassTerm(terms, term) {
  if (term.overwrites) {
    // Why: object spreads can overwrite a class key only on some branches;
    // the earlier class still exists on branches where the spread omits it.
    removeOverwrittenTerms(terms, term.text, term.condition)
  }
  terms.push(term)
}

function mergeClassTerms(termGroups) {
  const terms = []
  for (const group of termGroups) {
    for (const term of group) {
      appendClassTerm(terms, term)
    }
  }
  return terms
}

function propertyNameTerms(name, sourceFile) {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) {
    return [{ text: name.text, condition: [] }]
  }
  if (ts.isComputedPropertyName(name)) {
    return classTerms(name.expression, sourceFile)
  }
  return []
}

function staticPropertyName(name) {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) {
    return name.text
  }
  return undefined
}

function literalComputedPropertyName(name) {
  if (!ts.isComputedPropertyName(name)) {
    return undefined
  }
  const expression = name.expression
  return ts.isStringLiteralLike(expression) ? expression.text : undefined
}

function objectLiteralClassTerms(node, sourceFile, options = {}) {
  const terms = []

  for (const property of node.properties) {
    if (ts.isSpreadAssignment(property)) {
      for (const term of classTerms(property.expression, sourceFile, options)) {
        appendClassTerm(terms, term)
      }
      continue
    }

    if (!ts.isPropertyAssignment(property)) {
      continue
    }

    const staticName = staticPropertyName(property.name)
    const literalName = staticName ?? literalComputedPropertyName(property.name)
    if (options.allowConfigProperties && literalName && CLASS_CONFIG_PROPERTIES.has(literalName)) {
      terms.push(...classTerms(property.initializer, sourceFile))
      continue
    }

    const nameTerms = propertyNameTerms(property.name, sourceFile)
    if (nameTerms.length === 0) {
      continue
    }

    if (literalName) {
      removeOverwrittenTerms(terms, literalName)
    }

    const literalValue = booleanLiteralValue(property.initializer)
    if (literalValue === false) {
      if (literalName) {
        terms.push({ text: literalName, condition: [], overwrites: true, disabled: true })
      }
      continue
    }

    const conditions =
      literalValue === true ? [[]] : conditionBranchesForTruthy(property.initializer, sourceFile)
    for (const nameTerm of nameTerms) {
      for (const condition of conditions) {
        const combined = combineConditions(nameTerm.condition, condition)
        if (combined) {
          terms.push({ text: nameTerm.text, condition: combined, overwrites: Boolean(literalName) })
        }
      }
    }
  }

  return terms
}

function templateExpressionClassTerms(node, sourceFile, options = {}) {
  const terms = [{ text: node.head.text, condition: [] }]

  for (const span of node.templateSpans) {
    terms.push(...classTerms(span.expression, sourceFile, options))
    terms.push({ text: span.literal.text, condition: [] })
  }

  return terms
}

function calleeIdentifierName(node) {
  if (ts.isIdentifier(node)) {
    return node.text
  }
  if (ts.isPropertyAccessExpression(node)) {
    return node.name.text
  }
  return undefined
}

function isClassComposerCall(node) {
  if (!ts.isCallExpression(node)) {
    return false
  }
  const name = calleeIdentifierName(node.expression)
  return name ? CLASS_COMPOSER_FUNCTIONS.has(name) : false
}

function isLikelyClassHelperCall(node) {
  if (!ts.isCallExpression(node)) {
    return false
  }
  const name = calleeIdentifierName(node.expression)
  return name ? CLASS_HELPER_NAME_PATTERN.test(name) : false
}

function propertyAccessMethodName(node) {
  if (!ts.isPropertyAccessExpression(node.expression)) {
    return undefined
  }
  return node.expression.name.text
}

function propertyAccessReceiver(node) {
  if (!ts.isPropertyAccessExpression(node.expression)) {
    return undefined
  }
  return node.expression.expression
}

function isStaticMethodCall(node, objectName, methodName) {
  if (!ts.isPropertyAccessExpression(node.expression)) {
    return false
  }
  return (
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === objectName &&
    node.expression.name.text === methodName
  )
}

function isBooleanFilterCall(node) {
  if (propertyAccessMethodName(node) !== 'filter' || node.arguments.length !== 1) {
    return false
  }
  const [callback] = node.arguments
  return ts.isIdentifier(callback) && callback.text === 'Boolean'
}

function callbackExpression(callback) {
  if (ts.isArrowFunction(callback) && !ts.isBlock(callback.body)) {
    return callback.body
  }
  if (!ts.isFunctionExpression(callback) && !ts.isArrowFunction(callback)) {
    return undefined
  }

  const returnStatement = callback.body.statements.find(
    (statement) => ts.isReturnStatement(statement) && statement.expression
  )
  return returnStatement?.expression
}

function mappedClassTerms(node, receiver, sourceFile, options = {}) {
  const [callback] = node.arguments
  const mappedTerms = callback
    ? classTerms(callbackExpression(callback) ?? callback, sourceFile, options)
    : []
  return [...verticalScrollOnlyTerms(classTerms(receiver, sourceFile, options)), ...mappedTerms]
}

function arrayFromClassTerms(node, sourceFile, options = {}) {
  const [source, mapper] = node.arguments
  const sourceTerms = source ? classTerms(source, sourceFile, options) : []
  if (!mapper) {
    return sourceTerms
  }
  const mappedTerms = classTerms(callbackExpression(mapper) ?? mapper, sourceFile, options)
  return [...verticalScrollOnlyTerms(sourceTerms), ...mappedTerms]
}

function verticalScrollOnlyTerms(terms) {
  return terms.flatMap((term) => {
    if (term.disabled) {
      return []
    }
    return classTokens(term.text)
      .filter((token) => VERTICAL_SCROLL_CLASSES.has(plainClassName(token)))
      .map((text) => ({ text, condition: term.condition }))
  })
}

function literalVerticalScrollTerms(node) {
  const terms = []

  function visit(current) {
    const fragments = stringFragments(current)
    if (fragments.length > 0) {
      terms.push(...verticalScrollOnlyTerms(fragments.map((text) => ({ text, condition: [] }))))
    }

    ts.forEachChild(current, visit)
  }

  visit(node)
  return terms
}

function unsupportedCallClassTerms(node) {
  const methodName = propertyAccessMethodName(node)
  if (methodName && NON_CLASS_METHOD_CALLS.has(methodName)) {
    return []
  }

  return literalVerticalScrollTerms(node)
}

function literalElementAccessIndex(node) {
  if (!ts.isElementAccessExpression(node)) {
    return undefined
  }
  const argument = node.argumentExpression
  if (!argument || !ts.isNumericLiteral(argument)) {
    return undefined
  }
  return Number(argument.text)
}

function literalObjectPropertyValue(node, propertyName) {
  if (!ts.isObjectLiteralExpression(node)) {
    return undefined
  }

  for (let index = node.properties.length - 1; index >= 0; index -= 1) {
    const property = node.properties[index]
    if (!ts.isPropertyAssignment(property)) {
      continue
    }
    const name = staticPropertyName(property.name) ?? literalComputedPropertyName(property.name)
    if (name === propertyName) {
      return property.initializer
    }
  }
  return undefined
}

function resolvedStaticExpression(node, sourceFile, constBindings = new Map(), seen = new Set()) {
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node)
  ) {
    return resolvedStaticExpression(node.expression, sourceFile, constBindings, seen)
  }

  if (ts.isIdentifier(node) && constBindings.has(node.text) && !seen.has(node.text)) {
    seen.add(node.text)
    return resolvedStaticExpression(constBindings.get(node.text), sourceFile, constBindings, seen)
  }

  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    const selectedValue = staticSelectedPropertyValue(node, sourceFile, constBindings)
    if (selectedValue) {
      return resolvedStaticExpression(selectedValue, sourceFile, constBindings, seen)
    }
  }

  return node
}

function staticSelectedPropertyValue(node, sourceFile, constBindings = new Map()) {
  if (ts.isPropertyAccessExpression(node)) {
    const receiver = resolvedStaticExpression(node.expression, sourceFile, constBindings)
    return literalObjectPropertyValue(receiver, node.name.text)
  }

  if (
    ts.isElementAccessExpression(node) &&
    node.argumentExpression &&
    ts.isStringLiteralLike(node.argumentExpression)
  ) {
    const receiver = resolvedStaticExpression(node.expression, sourceFile, constBindings)
    return literalObjectPropertyValue(receiver, node.argumentExpression.text)
  }

  return undefined
}

function classTerms(node, sourceFile, options = {}) {
  if (ts.isTemplateExpression(node)) {
    return templateExpressionClassTerms(node, sourceFile, options)
  }

  if (ts.isTaggedTemplateExpression(node)) {
    return verticalScrollOnlyTerms(classTerms(node.template, sourceFile, options))
  }

  const fragments = stringFragments(node)
  if (fragments.length > 0) {
    return fragments.map((text) => ({ text, condition: [] }))
  }

  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node)
  ) {
    return classTerms(node.expression, sourceFile, options)
  }

  if (ts.isSpreadElement(node)) {
    return classTerms(node.expression, sourceFile, options)
  }

  if (ts.isConditionalExpression(node)) {
    const conditionValue = booleanLiteralValue(node.condition)
    if (conditionValue === true) {
      return classTerms(node.whenTrue, sourceFile, options)
    }
    if (conditionValue === false) {
      return classTerms(node.whenFalse, sourceFile, options)
    }
    return [
      ...applyConditions(
        classTerms(node.whenTrue, sourceFile, options),
        conditionBranchesForTruthy(node.condition, sourceFile)
      ),
      ...applyConditions(
        classTerms(node.whenFalse, sourceFile, options),
        conditionBranchesForFalsy(node.condition, sourceFile)
      )
    ]
  }

  if (ts.isBinaryExpression(node)) {
    const leftValue = booleanLiteralValue(node.left)
    if (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
      if (leftValue === true) {
        return classTerms(node.right, sourceFile, options)
      }
      if (leftValue === false) {
        return []
      }
      return applyConditions(
        classTerms(node.right, sourceFile, options),
        conditionBranchesForTruthy(node.left, sourceFile)
      )
    }
    if (node.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
      return [
        ...classTerms(node.left, sourceFile, options),
        ...applyConditions(
          classTerms(node.right, sourceFile, options),
          conditionBranchesForFalsy(node.left, sourceFile)
        )
      ]
    }
    if (node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) {
      return [
        ...classTerms(node.left, sourceFile, options),
        ...applyConditions(
          classTerms(node.right, sourceFile, options),
          conditionBranchesForNullish(node.left, sourceFile)
        )
      ]
    }
    if (node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      return [
        ...classTerms(node.left, sourceFile, options),
        ...classTerms(node.right, sourceFile, options)
      ]
    }
  }

  if (ts.isCallExpression(node)) {
    if (isClassComposerCall(node)) {
      return node.arguments.flatMap((argument) => classTerms(argument, sourceFile))
    }
    if (isLikelyClassHelperCall(node)) {
      return node.arguments.flatMap((argument) =>
        classTerms(argument, sourceFile, { allowConfigProperties: true })
      )
    }
    if (isStaticMethodCall(node, 'Object', 'assign')) {
      return mergeClassTerms(
        node.arguments.map((argument) => classTerms(argument, sourceFile, options))
      )
    }
    if (isStaticMethodCall(node, 'Array', 'of')) {
      return node.arguments.flatMap((argument) => classTerms(argument, sourceFile, options))
    }
    if (isStaticMethodCall(node, 'Array', 'from')) {
      return arrayFromClassTerms(node, sourceFile, options)
    }
    const methodName = propertyAccessMethodName(node)
    const receiver = propertyAccessReceiver(node)
    if (receiver && isBooleanFilterCall(node)) {
      return classTerms(receiver, sourceFile, options)
    }
    if (receiver && (methodName === 'filter' || methodName === 'slice')) {
      return verticalScrollOnlyTerms(classTerms(receiver, sourceFile, options))
    }
    if (receiver && methodName === 'map') {
      return mappedClassTerms(node, receiver, sourceFile, options)
    }
    if (receiver && methodName === 'flatMap') {
      return mappedClassTerms(node, receiver, sourceFile, options)
    }
    if (receiver && methodName && CLASS_CHAIN_RECEIVER_METHODS.has(methodName)) {
      return classTerms(receiver, sourceFile, options)
    }
    if (receiver && methodName && CLASS_CHAIN_RECEIVER_AND_ARGUMENT_METHODS.has(methodName)) {
      return [
        ...classTerms(receiver, sourceFile, options),
        ...node.arguments.flatMap((argument) => classTerms(argument, sourceFile, options))
      ]
    }
    return unsupportedCallClassTerms(node)
  }

  if (ts.isPropertyAccessExpression(node)) {
    const selectedValue = literalObjectPropertyValue(node.expression, node.name.text)
    if (selectedValue) {
      return classTerms(selectedValue, sourceFile, options)
    }
    return verticalScrollOnlyTerms(classTerms(node.expression, sourceFile, options))
  }

  if (ts.isElementAccessExpression(node)) {
    const index = literalElementAccessIndex(node)
    if (index !== undefined && ts.isArrayLiteralExpression(node.expression)) {
      const selectedValue = node.expression.elements[index]
      return selectedValue ? classTerms(selectedValue, sourceFile, options) : []
    }
    if (ts.isStringLiteralLike(node.argumentExpression)) {
      const selectedValue = literalObjectPropertyValue(
        node.expression,
        node.argumentExpression.text
      )
      if (selectedValue) {
        return classTerms(selectedValue, sourceFile, options)
      }
    }
    return verticalScrollOnlyTerms(classTerms(node.expression, sourceFile, options))
  }

  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.flatMap((element) => classTerms(element, sourceFile, options))
  }

  if (ts.isObjectLiteralExpression(node)) {
    return objectLiteralClassTerms(node, sourceFile, options)
  }

  return []
}

function isClassNameAttribute(node) {
  return ts.isJsxAttribute(node) && ts.isIdentifier(node.name) && node.name.text === 'className'
}

function classNameAttributeTerms(node, sourceFile) {
  if (!node.initializer) {
    return []
  }
  if (ts.isStringLiteral(node.initializer)) {
    return [{ text: node.initializer.text, condition: [] }]
  }
  if (!ts.isJsxExpression(node.initializer) || !node.initializer.expression) {
    return []
  }
  return classTerms(node.initializer.expression, sourceFile)
}

function isStyleAttribute(node) {
  return ts.isJsxAttribute(node) && ts.isIdentifier(node.name) && node.name.text === 'style'
}

function stylePropertyName(name) {
  return staticPropertyName(name) ?? literalComputedPropertyName(name)
}

function verticalScrollStyleTerm(propertyName, value) {
  const parts = value.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (parts.length === 0) {
    return undefined
  }

  if (propertyName === 'overflowY' || propertyName === 'overflow-y') {
    return VERTICAL_SCROLL_STYLE_VALUES.has(parts[0]) ? 'inline-vertical-scroll' : undefined
  }

  if (propertyName !== 'overflow') {
    return undefined
  }

  const verticalValue = parts.length > 1 ? parts[1] : parts[0]
  return VERTICAL_SCROLL_STYLE_VALUES.has(verticalValue) ? 'inline-vertical-scroll' : undefined
}

function styleValueTerms(propertyName, node, sourceFile, constBindings = new Map()) {
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node)
  ) {
    return styleValueTerms(propertyName, node.expression, sourceFile, constBindings)
  }

  if (ts.isIdentifier(node) && constBindings.has(node.text)) {
    return styleValueTerms(propertyName, constBindings.get(node.text), sourceFile, constBindings)
  }

  const fragments = stringFragments(node)
  if (fragments.length > 0) {
    return fragments.flatMap((value) => {
      const text = verticalScrollStyleTerm(propertyName, value)
      return text ? [{ text, condition: [] }] : []
    })
  }

  if (ts.isConditionalExpression(node)) {
    return [
      ...applyConditions(
        styleValueTerms(propertyName, node.whenTrue, sourceFile, constBindings),
        conditionBranchesForTruthy(node.condition, sourceFile)
      ),
      ...applyConditions(
        styleValueTerms(propertyName, node.whenFalse, sourceFile, constBindings),
        conditionBranchesForFalsy(node.condition, sourceFile)
      )
    ]
  }

  if (ts.isBinaryExpression(node)) {
    if (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
      return applyConditions(
        styleValueTerms(propertyName, node.right, sourceFile, constBindings),
        conditionBranchesForTruthy(node.left, sourceFile)
      )
    }
    if (node.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
      return [
        ...styleValueTerms(propertyName, node.left, sourceFile, constBindings),
        ...applyConditions(
          styleValueTerms(propertyName, node.right, sourceFile, constBindings),
          conditionBranchesForFalsy(node.left, sourceFile)
        )
      ]
    }
    if (node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) {
      return [
        ...styleValueTerms(propertyName, node.left, sourceFile, constBindings),
        ...applyConditions(
          styleValueTerms(propertyName, node.right, sourceFile, constBindings),
          conditionBranchesForNullish(node.left, sourceFile)
        )
      ]
    }
  }

  return []
}

function styleExpressionTerms(node, sourceFile, constBindings = new Map()) {
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node)
  ) {
    return styleExpressionTerms(node.expression, sourceFile, constBindings)
  }

  if (ts.isIdentifier(node) && constBindings.has(node.text)) {
    return styleExpressionTerms(constBindings.get(node.text), sourceFile, constBindings)
  }

  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    const selectedValue = staticSelectedPropertyValue(node, sourceFile, constBindings)
    if (selectedValue) {
      return styleExpressionTerms(selectedValue, sourceFile, constBindings)
    }
  }

  if (ts.isConditionalExpression(node)) {
    return [
      ...applyConditions(
        styleExpressionTerms(node.whenTrue, sourceFile, constBindings),
        conditionBranchesForTruthy(node.condition, sourceFile)
      ),
      ...applyConditions(
        styleExpressionTerms(node.whenFalse, sourceFile, constBindings),
        conditionBranchesForFalsy(node.condition, sourceFile)
      )
    ]
  }

  if (ts.isBinaryExpression(node)) {
    if (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
      return applyConditions(
        styleExpressionTerms(node.right, sourceFile, constBindings),
        conditionBranchesForTruthy(node.left, sourceFile)
      )
    }
    if (node.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
      return [
        ...styleExpressionTerms(node.left, sourceFile, constBindings),
        ...applyConditions(
          styleExpressionTerms(node.right, sourceFile, constBindings),
          conditionBranchesForFalsy(node.left, sourceFile)
        )
      ]
    }
    if (node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) {
      return [
        ...styleExpressionTerms(node.left, sourceFile, constBindings),
        ...applyConditions(
          styleExpressionTerms(node.right, sourceFile, constBindings),
          conditionBranchesForNullish(node.left, sourceFile)
        )
      ]
    }
  }

  if (ts.isCallExpression(node)) {
    return literalStyleVerticalScrollTerms(node, sourceFile, constBindings)
  }

  if (!ts.isObjectLiteralExpression(node)) {
    return []
  }

  const terms = []
  for (const property of node.properties) {
    if (ts.isSpreadAssignment(property)) {
      terms.push(...styleExpressionTerms(property.expression, sourceFile, constBindings))
      continue
    }
    if (ts.isShorthandPropertyAssignment(property)) {
      terms.push(...styleValueTerms(property.name.text, property.name, sourceFile, constBindings))
      continue
    }
    if (!ts.isPropertyAssignment(property)) {
      continue
    }

    const propertyName = stylePropertyName(property.name)
    if (!propertyName) {
      continue
    }
    terms.push(...styleValueTerms(propertyName, property.initializer, sourceFile, constBindings))
  }
  return terms
}

function literalStyleVerticalScrollTerms(node, sourceFile, constBindings = new Map()) {
  const terms = []

  function visit(current) {
    if (ts.isPropertyAssignment(current)) {
      const propertyName = stylePropertyName(current.name)
      if (propertyName) {
        terms.push(...styleValueTerms(propertyName, current.initializer, sourceFile, constBindings))
      }
    } else if (ts.isShorthandPropertyAssignment(current)) {
      terms.push(...styleValueTerms(current.name.text, current.name, sourceFile, constBindings))
    }
    ts.forEachChild(current, visit)
  }

  visit(node)
  return terms
}

function styleAttributeTerms(node, sourceFile, constBindings = new Map()) {
  if (!node.initializer || !ts.isJsxExpression(node.initializer) || !node.initializer.expression) {
    return []
  }
  return styleExpressionTerms(node.initializer.expression, sourceFile, constBindings)
}

function emptyJsxPropCase(condition = []) {
  return {
    condition,
    hasClassName: false,
    classNameTerms: [],
    hasStyle: false,
    styleTerms: []
  }
}

function applyJsxPropCaseConditions(cases, conditionBranches) {
  return cases.flatMap((props) => {
    return conditionBranches.flatMap((condition) => {
      const combined = combineConditions(props.condition, condition)
      return combined ? [{ ...props, condition: combined }] : []
    })
  })
}

function mergeJsxPropCases(targetCases, sourceCases) {
  const mergedCases = []
  for (const target of targetCases) {
    for (const source of sourceCases) {
      const condition = combineConditions(target.condition, source.condition)
      if (!condition) {
        continue
      }

      // Why: JSX spreads only overwrite props on branches where the spread
      // actually contains that prop; omitted branches keep the earlier prop.
      mergedCases.push({
        condition,
        hasClassName: target.hasClassName || source.hasClassName,
        classNameTerms: source.hasClassName ? source.classNameTerms : target.classNameTerms,
        hasStyle: target.hasStyle || source.hasStyle,
        styleTerms: source.hasStyle ? source.styleTerms : target.styleTerms
      })
    }
  }
  return mergedCases
}

function jsxPropCasesTerms(cases) {
  return cases.flatMap((props) => [
    ...applyConditions(props.classNameTerms, [props.condition]),
    ...applyConditions(props.styleTerms, [props.condition])
  ])
}

function setJsxPropCaseClassName(props, terms) {
  return { ...props, hasClassName: true, classNameTerms: terms }
}

function setJsxPropCaseStyle(props, terms) {
  return { ...props, hasStyle: true, styleTerms: terms }
}

function jsxSpreadExpressionCases(node, sourceFile, constBindings = new Map()) {
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node)
  ) {
    return jsxSpreadExpressionCases(node.expression, sourceFile, constBindings)
  }

  if (ts.isIdentifier(node) && constBindings.has(node.text)) {
    return jsxSpreadExpressionCases(constBindings.get(node.text), sourceFile, constBindings)
  }

  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    const selectedValue = staticSelectedPropertyValue(node, sourceFile, constBindings)
    if (selectedValue) {
      return jsxSpreadExpressionCases(selectedValue, sourceFile, constBindings)
    }
  }

  if (ts.isConditionalExpression(node)) {
    return [
      ...applyJsxPropCaseConditions(
        jsxSpreadExpressionCases(node.whenTrue, sourceFile, constBindings),
        conditionBranchesForTruthy(node.condition, sourceFile)
      ),
      ...applyJsxPropCaseConditions(
        jsxSpreadExpressionCases(node.whenFalse, sourceFile, constBindings),
        conditionBranchesForFalsy(node.condition, sourceFile)
      )
    ]
  }

  if (ts.isBinaryExpression(node)) {
    if (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
      return [
        ...applyJsxPropCaseConditions(
          jsxSpreadExpressionCases(node.right, sourceFile, constBindings),
          conditionBranchesForTruthy(node.left, sourceFile)
        ),
        ...applyJsxPropCaseConditions(
          [emptyJsxPropCase()],
          conditionBranchesForFalsy(node.left, sourceFile)
        )
      ]
    }
    if (node.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
      return [
        ...applyJsxPropCaseConditions(
          jsxSpreadExpressionCases(node.left, sourceFile, constBindings),
          conditionBranchesForTruthy(node.left, sourceFile)
        ),
        ...applyJsxPropCaseConditions(
          jsxSpreadExpressionCases(node.right, sourceFile, constBindings),
          conditionBranchesForFalsy(node.left, sourceFile)
        )
      ]
    }
    if (node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) {
      return [
        ...applyJsxPropCaseConditions(
          jsxSpreadExpressionCases(node.left, sourceFile, constBindings),
          conditionBranchesForNonNullish(node.left, sourceFile)
        ),
        ...applyJsxPropCaseConditions(
          jsxSpreadExpressionCases(node.right, sourceFile, constBindings),
          conditionBranchesForNullish(node.left, sourceFile)
        )
      ]
    }
  }

  if (!ts.isObjectLiteralExpression(node)) {
    return [emptyJsxPropCase()]
  }

  let cases = [emptyJsxPropCase()]
  for (const property of node.properties) {
    if (ts.isSpreadAssignment(property)) {
      cases = mergeJsxPropCases(
        cases,
        jsxSpreadExpressionCases(property.expression, sourceFile, constBindings)
      )
      continue
    }
    if (!ts.isPropertyAssignment(property)) {
      continue
    }

    const propertyName =
      staticPropertyName(property.name) ?? literalComputedPropertyName(property.name)
    if (propertyName === 'className') {
      const terms = classTerms(property.initializer, sourceFile)
      cases = cases.map((props) => setJsxPropCaseClassName(props, terms))
    } else if (propertyName === 'style') {
      const terms = styleExpressionTerms(property.initializer, sourceFile, constBindings)
      cases = cases.map((props) => setJsxPropCaseStyle(props, terms))
    }
  }
  return cases
}

function jsxElementClassTerms(node, sourceFile, constBindings = new Map()) {
  let cases = [emptyJsxPropCase()]
  for (const attribute of node.attributes.properties) {
    if (isClassNameAttribute(attribute)) {
      const terms = classNameAttributeTerms(attribute, sourceFile)
      cases = cases.map((props) => setJsxPropCaseClassName(props, terms))
    } else if (isStyleAttribute(attribute)) {
      const terms = styleAttributeTerms(attribute, sourceFile, constBindings)
      cases = cases.map((props) => setJsxPropCaseStyle(props, terms))
    } else if (ts.isJsxSpreadAttribute(attribute)) {
      cases = mergeJsxPropCases(
        cases,
        jsxSpreadExpressionCases(attribute.expression, sourceFile, constBindings)
      )
    }
  }
  return jsxPropCasesTerms(cases)
}

function reportIfUnstyledVerticalScroll(
  node,
  fragments,
  filePath,
  sourceFile,
  sourceText,
  reports
) {
  const terms = fragments.map((text) => ({ text, condition: [] }))
  const offendingTerm = unstyledVerticalScrollOccurrence(terms)
  if (offendingTerm) {
    const { line, column } = lineAndColumnForPosition(sourceText, node.getStart(sourceFile))
    reports.push({ filePath, line, column, text: fragments.join('${...}').trim() })
  }
}

function conditionImpliesScrollbar(overflowCondition, scrollbarCondition) {
  return scrollbarCondition.every((atom) =>
    overflowCondition.some((overflowAtom) => atomImplies(overflowAtom, atom))
  )
}

function statesForAtom(atom) {
  const { kind, value } = parsedAtom(atom)
  if (kind === 'truthy') {
    return value ? ['truthy'] : ['nullish', 'falsy']
  }
  return value ? ['nullish'] : ['falsy', 'truthy']
}

function intersectStates(left, right) {
  return left.filter((state) => right.includes(state))
}

function conditionStateConstraints(condition) {
  const constraints = new Map()
  for (const atom of condition) {
    const { expression } = parsedAtom(atom)
    const states = statesForAtom(atom)
    const nextStates = constraints.has(expression)
      ? intersectStates(constraints.get(expression), states)
      : states
    if (nextStates.length === 0) {
      return undefined
    }
    constraints.set(expression, nextStates)
  }
  return constraints
}

function assignmentSatisfiesCondition(assignment, condition) {
  return condition.every((atom) => {
    const { expression } = parsedAtom(atom)
    return statesForAtom(atom).includes(assignment.get(expression))
  })
}

function conditionExpressions(condition) {
  return condition.map((atom) => parsedAtom(atom).expression)
}

function conditionSetsCover(overflowCondition, scrollbarConditions) {
  if (scrollbarConditions.length === 0) {
    return false
  }

  if (
    scrollbarConditions.some((scrollbarCondition) =>
      conditionImpliesScrollbar(overflowCondition, scrollbarCondition)
    )
  ) {
    return true
  }

  const overflowConstraints = conditionStateConstraints(overflowCondition)
  if (!overflowConstraints) {
    return false
  }

  const expressions = Array.from(
    new Set([
      ...conditionExpressions(overflowCondition),
      ...scrollbarConditions.flatMap(conditionExpressions)
    ])
  )

  if (expressions.length > 8) {
    return false
  }

  const assignment = new Map()

  function covers(index) {
    if (index === expressions.length) {
      return scrollbarConditions.some((condition) =>
        assignmentSatisfiesCondition(assignment, condition)
      )
    }

    const expression = expressions[index]
    const allowedStates = overflowConstraints.get(expression) ?? CONDITION_STATES
    for (const state of allowedStates) {
      assignment.set(expression, state)
      if (!covers(index + 1)) {
        assignment.delete(expression)
        return false
      }
    }
    assignment.delete(expression)

    return true
  }

  return covers(0)
}

function classOccurrences(terms, classes) {
  const occurrences = []

  for (const term of terms) {
    if (term.disabled) {
      continue
    }
    for (const token of classTokens(term.text)) {
      const { className, variants } = classTokenParts(token)
      if (!classes.has(className)) {
        continue
      }
      const condition = combineConditions(
        term.condition,
        variants.map((variant) => variantAtom(variant))
      )
      if (condition) {
        occurrences.push({ text: token, condition })
      }
    }
  }

  return occurrences
}

function unstyledVerticalScrollOccurrence(terms) {
  const scrollbarConditions = classOccurrences(terms, STYLED_SCROLLBAR_CLASSES).map(
    (candidate) => candidate.condition
  )
  return classOccurrences(terms, VERTICAL_SCROLL_CLASSES).find(
    (term) => !conditionSetsCover(term.condition, scrollbarConditions)
  )
}

function reportUnstyledClassTerms(node, terms, filePath, sourceFile, sourceText, reports) {
  const offendingTerm = unstyledVerticalScrollOccurrence(terms)
  if (offendingTerm) {
    const { line, column } = lineAndColumnForPosition(sourceText, node.getStart(sourceFile))
    reports.push({ filePath, line, column, text: offendingTerm.text.trim() })
  }
}

function isBlockScope(node) {
  return (
    ts.isSourceFile(node) ||
    ts.isBlock(node) ||
    ts.isCaseBlock(node) ||
    ts.isModuleBlock(node) ||
    ts.isFunctionLike(node)
  )
}

function collectConstBindings(scopeNode) {
  const bindings = new Map()
  const duplicateNames = new Set()

  function visit(node) {
    if (node !== scopeNode && isBlockScope(node)) {
      return
    }

    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isVariableDeclarationList(node.parent) &&
      (node.parent.flags & ts.NodeFlags.Const) !== 0
    ) {
      const name = node.name.text
      if (bindings.has(name)) {
        bindings.delete(name)
        duplicateNames.add(name)
      } else if (!duplicateNames.has(name)) {
        bindings.set(name, node.initializer)
      }
    }

    ts.forEachChild(node, visit)
  }

  visit(scopeNode)
  return bindings
}

function lexicalConstBindingsForNode(node) {
  const bindings = new Map()
  let current = node

  while (current) {
    if (isBlockScope(current)) {
      const scopeBindings = collectConstBindings(current)
      for (const [name, initializer] of scopeBindings) {
        if (!bindings.has(name)) {
          bindings.set(name, initializer)
        }
      }
    }
    current = current.parent
  }

  return bindings
}

export function reportUnstyledScrollbars(filePath, sourceText) {
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith('.tsx') || filePath.endsWith('.jsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  )
  const reports = []

  function visit(node) {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      reportUnstyledClassTerms(
        node,
        jsxElementClassTerms(node, sourceFile, lexicalConstBindingsForNode(node)),
        filePath,
        sourceFile,
        sourceText,
        reports
      )
      return
    }

    if (isClassNameAttribute(node)) {
      reportUnstyledClassTerms(
        node,
        classNameAttributeTerms(node, sourceFile),
        filePath,
        sourceFile,
        sourceText,
        reports
      )
      return
    }

    if (isClassComposerCall(node) || ts.isTemplateExpression(node)) {
      reportUnstyledClassTerms(
        node,
        classTerms(node, sourceFile),
        filePath,
        sourceFile,
        sourceText,
        reports
      )
      return
    }

    const fragments = stringFragments(node)
    reportIfUnstyledVerticalScroll(node, fragments, filePath, sourceFile, sourceText, reports)
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return reports
}

export async function collectUnstyledScrollbarReports(root = process.cwd()) {
  const scanRoot = path.join(root, 'src', 'renderer', 'src')
  const files = await collectSourceFiles(root, scanRoot)
  const reports = []

  for (const filePath of files) {
    const sourceText = await fs.readFile(filePath, 'utf8')
    reports.push(...reportUnstyledScrollbars(filePath, sourceText))
  }

  return reports
}

export function formatReports(root, reports) {
  return reports
    .map(
      (report) =>
        `${normalizePath(root, report.filePath)}:${report.line}:${report.column} ${report.text.replace(/\s+/g, ' ')}`
    )
    .join('\n')
}

export async function main(root = process.cwd()) {
  const reports = await collectUnstyledScrollbarReports(root)
  if (reports.length === 0) {
    return 0
  }

  console.error('Renderer vertical scroll containers must use an Orca scrollbar style.')
  console.error(
    'Add scrollbar-sleek, scrollbar-editor, worktree-sidebar-scrollbar, or use the shadcn ScrollArea wrapper.'
  )
  console.error('')
  console.error(formatReports(root, reports))
  return 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main())
}
