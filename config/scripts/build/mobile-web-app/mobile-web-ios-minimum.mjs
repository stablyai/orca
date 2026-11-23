import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RegExpParser, visitRegExpAST } from '@eslint-community/regexpp'
import ts from 'typescript-api'

const appJson = join(fileURLToPath(new URL('../../../..', import.meta.url)), 'mobile', 'app.json')

// Xcode 27 builds nothing below iOS 15, so features iOS 15 already had need no entry below.
const OLDEST_DECLARABLE_IOS = '15.0'

/** The App Store minimum: app.json's ios.deploymentTarget, which Expo writes into the Xcode app target. */
export function readMobileIosMinimum(path = appJson) {
  const minimum = JSON.parse(readFileSync(path, 'utf8')).expo?.ios?.deploymentTarget
  if (typeof minimum !== 'string' || !/^\d+(\.\d+)?$/.test(minimum)) {
    throw new Error(`${path} declares no expo.ios.deploymentTarget like "16.4"`)
  }
  if (compareIosVersions(minimum, OLDEST_DECLARABLE_IOS) < 0) {
    throw new Error(`expo.ios.deploymentTarget ${minimum} is below iOS ${OLDEST_DECLARABLE_IOS}`)
  }
  return minimum
}

function compareIosVersions(left, right) {
  const [leftMajor, leftMinor = 0] = left.split('.').map(Number)
  const [rightMajor, rightMinor = 0] = right.split('.').map(Number)
  return leftMajor - rightMajor || leftMinor - rightMinor
}

// The first iOS whose WebKit has each feature. null: no WebKit release confirmed yet, so it always fails.
export const IOS_FEATURE_SINCE = {
  'regex lookbehind': '16.4',
  'regex d flag': '15.0',
  'regex v flag': '17.0',
  'regex duplicate named groups': '17.0',
  'regex modifiers': null,
  'class static block': '16.4',
  'private #name in object': '15.0',
  'private method': '15.0',
  'top-level await': '15.0',
  'using declaration': null,
  structuredClone: '15.4',
  'Object.hasOwn': '15.4',
  'AbortSignal.timeout': '16.0',
  'Array.fromAsync': '16.4',
  'Object.groupBy': '17.4',
  'Map.groupBy': '17.4',
  'Promise.withResolvers': '17.4',
  'AbortSignal.any': '17.4',
  'Promise.try': '18.2',
  'RegExp.escape': '18.2',
  'Uint8Array.fromBase64': '18.2',
  'Iterator.from': '18.4'
}

// Statics whose receiver names them, so a call is unambiguous. Prototype methods (Set#union,
// Array#at) are not: a minified receiver could be any object with a method of that name.
const STATIC_CALLS = new Set(
  Object.keys(IOS_FEATURE_SINCE).filter((name) => /^[A-Z]\w*\.\w+$/.test(name))
)
const GLOBAL_CALLS = new Set(['structuredClone'])

const LOOKBEHIND_IN_TEXT = /\(\?<[=!]/

const regexParser = new RegExpParser({ ecmaVersion: 2025 })

function regexFeatures(pattern, flags) {
  const found = new Set()
  if (flags.includes('d')) {
    found.add('regex d flag')
  }
  if (flags.includes('v')) {
    found.add('regex v flag')
  }
  const ast = regexParser.parsePattern(pattern, 0, pattern.length, {
    unicode: flags.includes('u'),
    unicodeSets: flags.includes('v')
  })
  const names = new Set()
  visitRegExpAST(ast, {
    onAssertionEnter(node) {
      if (node.kind === 'lookbehind') {
        found.add('regex lookbehind')
      }
    },
    onCapturingGroupEnter(node) {
      if (node.name === null) {
        return
      }
      if (names.has(node.name)) {
        found.add('regex duplicate named groups')
      }
      names.add(node.name)
    },
    onModifiersEnter() {
      found.add('regex modifiers')
    }
  })
  return found
}

const isFunctionBoundary = (node) =>
  ts.isFunctionLike(node) || ts.isClassStaticBlockDeclaration(node)

// A feature probe: the construct sits in a try block that catches, or behind a test naming it.
function isGuarded(node, name) {
  for (let child = node, parent = node.parent; parent; child = parent, parent = parent.parent) {
    if (isFunctionBoundary(parent)) {
      return false
    }
    if (ts.isTryStatement(parent) && parent.tryBlock === child && parent.catchClause) {
      return true
    }
    const test =
      ts.isIfStatement(parent) && parent.thenStatement === child
        ? parent.expression
        : ts.isConditionalExpression(parent) && parent.whenTrue === child
          ? parent.condition
          : ts.isBinaryExpression(parent) &&
              parent.right === child &&
              parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
            ? parent.left
            : undefined
    if (name !== undefined && test?.getText().includes(name)) {
      return true
    }
  }
  return false
}

function insideFunction(node) {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (isFunctionBoundary(parent)) {
      return true
    }
  }
  return false
}

// A RegExp built from a string: the pattern's text with substitutions as plain letters, and its flags.
function constructedPattern(node) {
  const [source, flags] = node.arguments ?? []
  const text = !source
    ? undefined
    : ts.isStringLiteralLike(source)
      ? source.text
      : ts.isTemplateExpression(source)
        ? [source.head.text, ...source.templateSpans.map((span) => span.literal.text)].join('x')
        : undefined
  return text === undefined
    ? undefined
    : { text, flags: flags && ts.isStringLiteralLike(flags) ? flags.text : '' }
}

function calleeName(node) {
  const callee = node.expression
  if (ts.isIdentifier(callee)) {
    return callee.text
  }
  if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) {
    return `${callee.expression.text}.${callee.name.text}`
  }
  return undefined
}

/**
 * Every feature in one built script that WebKit before `minimum` lacks: syntax that stops the chunk
 * parsing, regex features in literals and in the strings RegExp is built from, and static built-ins.
 */
export function findFeaturesPastIosMinimum(source, assetPath, minimum) {
  const sourceFile = ts.createSourceFile(
    assetPath,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS
  )
  const [diagnostic] = sourceFile.parseDiagnostics
  if (diagnostic !== undefined) {
    throw new Error(
      `${assetPath} could not be parsed: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`
    )
  }
  const found = []
  const report = (feature, node) => {
    const since = IOS_FEATURE_SINCE[feature]
    if (since === null || compareIosVersions(since, minimum) > 0) {
      found.push({ feature, since, text: node.getText().slice(0, 120) })
    }
  }
  // A literal no parser accepts fails; a built pattern may only read oddly with its substitutions.
  const reportRegex = (pattern, flags, node, literal) => {
    let features
    try {
      features = regexFeatures(pattern, flags)
    } catch (error) {
      if (literal) {
        throw new Error(
          `${assetPath} has a regex no engine accepts: /${pattern}/${flags}: ${error.message}`
        )
      }
      features = LOOKBEHIND_IN_TEXT.test(pattern) ? ['regex lookbehind'] : []
    }
    for (const feature of features) {
      report(feature, node)
    }
  }
  // A RegExp's own pattern argument is read once, as a pattern, not again as lookbehind text.
  const readPatterns = new Set()
  const visit = (node) => {
    if (readPatterns.has(node)) {
      return
    }
    if (ts.isRegularExpressionLiteral(node)) {
      const end = node.text.lastIndexOf('/')
      reportRegex(node.text.slice(1, end), node.text.slice(end + 1), node, true)
    } else if (
      (ts.isNewExpression(node) || ts.isCallExpression(node)) &&
      calleeName(node) === 'RegExp'
    ) {
      const pattern = constructedPattern(node)
      if (pattern) {
        readPatterns.add(node.arguments[0])
        if (!isGuarded(node)) {
          reportRegex(pattern.text, pattern.flags, node, false)
        }
      }
    } else if (
      (ts.isStringLiteralLike(node) || ts.isTemplateLiteralToken(node)) &&
      LOOKBEHIND_IN_TEXT.test(node.text) &&
      !isGuarded(node)
    ) {
      // Patterns assembled from parts reach RegExp through variables, so any lookbehind text counts.
      report('regex lookbehind', node)
    } else if (ts.isClassStaticBlockDeclaration(node)) {
      report('class static block', node)
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.InKeyword &&
      ts.isPrivateIdentifier(node.left)
    ) {
      report('private #name in object', node)
    } else if (
      (ts.isMethodDeclaration(node) || ts.isGetAccessor(node) || ts.isSetAccessor(node)) &&
      ts.isPrivateIdentifier(node.name)
    ) {
      report('private method', node)
    } else if (
      (ts.isAwaitExpression(node) || (ts.isForOfStatement(node) && node.awaitModifier)) &&
      !insideFunction(node)
    ) {
      report('top-level await', node)
    } else if (ts.isVariableDeclarationList(node) && (node.flags & ts.NodeFlags.Using) !== 0) {
      report('using declaration', node)
    } else if (ts.isCallExpression(node)) {
      const name = calleeName(node)
      if ((STATIC_CALLS.has(name) || GLOBAL_CALLS.has(name)) && !isGuarded(node, name)) {
        report(name, node)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return found
}
