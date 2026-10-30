// Any input below iOS focus-zoom floor changes whole page scale and disables keyboard-occlusion for session.
// Census route closure, not just known seam sites: first fix raised two inputs but left eight able to trigger zoom.
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript-api'

export const TEXT_INPUT_FONT_SIZE_SEAM = 'src/platform/text-input-font-size.web.ts'

const SEAM_EXPORT = 'TEXT_INPUT_FONT_SIZE'
const SEAM_MODULE = 'src/platform/text-input-font-size.ts'

const FLOOR_EXPORT = 'TEXT_INPUT_FONT_SIZE_FLOOR'

const parse = (file, source) => ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)

const floorByRoot = new Map()

// Read seam’s floor rather than copy 16 beside max(bodySize,floor); missing declaration throws so moved/deleted seam cannot silently pass.
export function textInputFontSizeFloor(mobileDir) {
  const cached = floorByRoot.get(mobileDir)
  if (cached !== undefined) {
    return cached
  }
  const source = readOrNull(join(mobileDir, TEXT_INPUT_FONT_SIZE_SEAM))
  if (source === null) {
    throw new Error(`[text-input-font-size-seam] no seam at ${TEXT_INPUT_FONT_SIZE_SEAM}`)
  }
  const parsed = parse(TEXT_INPUT_FONT_SIZE_SEAM, source)
  const declared = declarationOf(parsed, FLOOR_EXPORT)
  if (declared === null || !ts.isNumericLiteral(declared)) {
    throw new Error(
      `[text-input-font-size-seam] ${TEXT_INPUT_FONT_SIZE_SEAM} declares no numeric ${FLOOR_EXPORT}`
    )
  }
  const floor = Number(declared.text)
  floorByRoot.set(mobileDir, floor)
  return floor
}

function readOrNull(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

// Match builder resolution with web siblings first; native-safe/web-unsafe split must not falsely pass.
const RESOLVED_EXTENSIONS = [
  '.web.tsx',
  '.web.ts',
  '.tsx',
  '.ts',
  '/index.web.tsx',
  '/index.web.ts',
  '/index.tsx',
  '/index.ts'
]

function resolveLocal(mobileDir, fromFile, specifier) {
  if (!specifier.startsWith('.')) {
    return null
  }
  const base = resolve(dirname(join(mobileDir, fromFile)), specifier)
  for (const extension of RESOLVED_EXTENSIONS) {
    if (existsSync(base + extension)) {
      // Use root-relative path operation; slicing leaves separator when root lacks trailing slash.
      return relative(mobileDir, base + extension).replaceAll('\\', '/')
    }
  }
  return null
}

// Normalize platform suffix for binding identity: seam itself has web sibling, whose resolved path must still match native-named import.
function moduleIdentity(path) {
  return path === null ? null : path.replace(/\.web(\.[jt]sx?)$/, '$1')
}

// Flatten actual style branches (arrays/spreads/&&/ternaries/parens), ignoring nullish/false nonstyles.
// Generic subtree walk would misread inline object properties as independent style references.
function styleExpressions(expression) {
  if (ts.isJsxExpression(expression)) {
    return expression.expression === undefined ? [] : styleExpressions(expression.expression)
  }
  if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression)) {
    return styleExpressions(expression.expression)
  }
  if (ts.isArrayLiteralExpression(expression)) {
    return expression.elements.flatMap((element) => styleExpressions(element))
  }
  if (ts.isSpreadElement(expression)) {
    return styleExpressions(expression.expression)
  }
  if (ts.isConditionalExpression(expression)) {
    return [...styleExpressions(expression.whenTrue), ...styleExpressions(expression.whenFalse)]
  }
  if (ts.isBinaryExpression(expression)) {
    const kind = expression.operatorToken.kind
    if (kind === ts.SyntaxKind.AmpersandAmpersandToken) {
      return styleExpressions(expression.right)
    }
    if (kind === ts.SyntaxKind.BarBarToken || kind === ts.SyntaxKind.QuestionQuestionToken) {
      return [...styleExpressions(expression.left), ...styleExpressions(expression.right)]
    }
    return [expression]
  }
  if (
    expression.kind === ts.SyntaxKind.NullKeyword ||
    expression.kind === ts.SyntaxKind.FalseKeyword ||
    (ts.isIdentifier(expression) && expression.text === 'undefined')
  ) {
    return []
  }
  return [expression]
}

// Derive actual TextInput modules by JSX tags, not mentions; exported census checks handwritten closure completeness.
export function modulesDeclaringTextInput(mobileDir, directory) {
  const found = []
  const walk = (relativeDirectory) => {
    const absolute = join(mobileDir, relativeDirectory)
    if (!existsSync(absolute)) {
      return
    }
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      const child = `${relativeDirectory}/${entry.name}`
      if (entry.isDirectory()) {
        walk(child)
        continue
      }
      if (!/\.(tsx|ts)$/.test(entry.name) || /\.test\.(tsx|ts)$/.test(entry.name)) {
        continue
      }
      const source = readOrNull(join(mobileDir, child))
      if (source !== null && declaresTextInput(parse(child, source))) {
        found.push(child)
      }
    }
  }
  walk(directory)
  return found.sort()
}

function declaresTextInput(parsed) {
  let found = false
  const visit = (node) => {
    if (found) {
      return
    }
    if (
      (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) &&
      node.tagName.getText() === 'TextInput'
    ) {
      found = true
      return
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(parsed, visit)
  return found
}

// Model styles.key, inline object and unresolved shapes explicitly; unknown call/identifier must not vanish as clean.
function textInputStyleRefs(parsed) {
  const refs = []
  const visit = (node) => {
    const element = ts.isJsxSelfClosingElement(node)
      ? node
      : ts.isJsxOpeningElement(node)
        ? node
        : null
    if (element !== null && element.tagName.getText() === 'TextInput') {
      for (const attribute of element.attributes.properties) {
        if (
          !ts.isJsxAttribute(attribute) ||
          attribute.name.getText() !== 'style' ||
          attribute.initializer === undefined
        ) {
          continue
        }
        const line = parsed.getLineAndCharacterOfPosition(element.getStart(parsed)).line + 1
        for (const expression of styleExpressions(attribute.initializer)) {
          if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression)) {
            refs.push({
              kind: 'ref',
              object: expression.expression.text,
              key: expression.name.text,
              line
            })
            continue
          }
          if (ts.isObjectLiteralExpression(expression)) {
            refs.push({ kind: 'inline', node: expression, key: 'inline style', line })
            continue
          }
          refs.push({ kind: 'opaque', key: expression.getText().slice(0, 40), line })
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(parsed, visit)
  return refs
}

function originOf(mobileDir, parsed, file, name) {
  for (const statement of parsed.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
      continue
    }
    const bindings = statement.importClause?.namedBindings
    if (bindings === undefined || !ts.isNamedImports(bindings)) {
      continue
    }
    for (const element of bindings.elements) {
      if (element.name.text !== name) {
        continue
      }
      const target = resolveLocal(mobileDir, file, statement.moduleSpecifier.text)
      return target === null
        ? null
        : { file: target, name: (element.propertyName ?? element.name).text }
    }
  }
  return { file, name }
}

// Recognize seam by imported binding, not same-spelled local constant or unrelated import.
function isSeamBinding(mobileDir, parsed, file, initializer) {
  if (!ts.isIdentifier(initializer)) {
    return false
  }
  for (const statement of parsed.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
      continue
    }
    const bindings = statement.importClause?.namedBindings
    if (bindings === undefined || !ts.isNamedImports(bindings)) {
      continue
    }
    for (const element of bindings.elements) {
      if (
        element.name.text === initializer.text &&
        (element.propertyName ?? element.name).text === SEAM_EXPORT &&
        moduleIdentity(resolveLocal(mobileDir, file, statement.moduleSpecifier.text)) ===
          SEAM_MODULE
      ) {
        return true
      }
    }
  }
  return false
}

function declarationOf(parsed, name) {
  let found = null
  const visit = (node) => {
    if (
      found === null &&
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name
    ) {
      found = node.initializer ?? null
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(parsed, visit)
  return found
}

// Unwrap StyleSheet.create({...}) and themedStyleSheet(() => ({...})) to the object they build.
function styleObjectOf(initializer) {
  if (initializer === null || initializer === undefined) {
    return null
  }
  if (ts.isObjectLiteralExpression(initializer)) {
    return initializer
  }
  if (ts.isParenthesizedExpression(initializer)) {
    return styleObjectOf(initializer.expression)
  }
  if (ts.isArrowFunction(initializer) && !ts.isBlock(initializer.body)) {
    return styleObjectOf(initializer.body)
  }
  if (ts.isCallExpression(initializer) && initializer.arguments.length > 0) {
    return styleObjectOf(initializer.arguments[0])
  }
  return null
}

// Distinguish missing key (unresolved hole) from found key without fontSize (inheritance).
// Follow cross-module spreads used by both real screens or absent result could falsely clear unsafe input.
function resolveStyleKey(mobileDir, file, exportName, key, seen = new Set()) {
  const id = `${file}|${exportName}|${key}`
  if (seen.has(id)) {
    return null
  }
  seen.add(id)
  const source = readOrNull(join(mobileDir, file))
  if (source === null) {
    return null
  }
  const parsed = parse(file, source)
  const object = styleObjectOf(declarationOf(parsed, exportName))
  if (object === null) {
    return null
  }
  // Search direct keys and spreads in reverse source order; later legacy spread overrides earlier safe key.
  for (const property of object.properties.toReversed()) {
    if (ts.isSpreadAssignment(property) && ts.isIdentifier(property.expression)) {
      const origin = originOf(mobileDir, parsed, file, property.expression.text)
      if (origin === null) {
        continue
      }
      const hit = resolveStyleKey(mobileDir, origin.file, origin.name, key, seen)
      if (hit !== null) {
        return hit
      }
      continue
    }
    if (
      !ts.isPropertyAssignment(property) ||
      property.name.getText().replaceAll(/['"]/g, '') !== key ||
      !ts.isObjectLiteralExpression(property.initializer)
    ) {
      continue
    }
    return { size: fontSizeIn(mobileDir, parsed, file, property.initializer) }
  }
  return null
}

// Numeric literals at/above floor are valid without seam binding; forcing larger fields onto seam could shrink them.
// Do not evaluate expressions: theme arithmetic can drift and census must not become second renderer.
function isLiteralAtOrAboveFloor(mobileDir, initializer) {
  return (
    ts.isNumericLiteral(initializer) &&
    Number(initializer.text) >= textInputFontSizeFloor(mobileDir)
  )
}

function fontSizeIn(mobileDir, parsed, file, object) {
  for (const entry of object.properties) {
    if (ts.isPropertyAssignment(entry) && entry.name.getText() === 'fontSize') {
      return {
        file,
        text: entry.initializer.getText(),
        line: parsed.getLineAndCharacterOfPosition(entry.getStart(parsed)).line + 1,
        onSeam:
          isSeamBinding(mobileDir, parsed, file, entry.initializer) ||
          isLiteralAtOrAboveFloor(mobileDir, entry.initializer)
      }
    }
  }
  return null
}

function textInputStyleResolutions(mobileDir, closure) {
  const found = []
  for (const file of closure.local) {
    const source = readOrNull(join(mobileDir, file))
    if (source === null || !source.includes('TextInput')) {
      continue
    }
    const parsed = parse(file, source)
    for (const ref of textInputStyleRefs(parsed)) {
      const at = `${file}:${ref.line}`
      if (ref.kind === 'opaque') {
        found.push({ at, key: ref.key, resolved: null })
        continue
      }
      if (ref.kind === 'inline') {
        found.push({
          at,
          key: ref.key,
          resolved: { size: fontSizeIn(mobileDir, parsed, file, ref.node) }
        })
        continue
      }
      const origin = originOf(mobileDir, parsed, file, ref.object)
      found.push({
        at,
        key: ref.key,
        resolved:
          origin === null ? null : resolveStyleKey(mobileDir, origin.file, origin.name, ref.key)
      })
    }
  }
  return found
}

// Report package/call/unknown style resolutions as holes; zero offenders proves safety only after every input was read.
export function unresolvedTextInputStyles(mobileDir, closure) {
  return textInputStyleResolutions(mobileDir, closure)
    .filter((entry) => entry.resolved === null)
    .map((entry) => `${entry.at} (${entry.key})`)
    .sort()
}

// Absent fontSize inherits and is not offender; report size declaration’s path/line, which may differ from input module.
export function textInputFontSizeOffenders(mobileDir, closure) {
  const offenders = new Set()
  for (const entry of textInputStyleResolutions(mobileDir, closure)) {
    const size = entry.resolved?.size
    if (size !== undefined && size !== null && !size.onSeam) {
      offenders.add(`${size.file}:${size.line}`)
    }
  }
  return [...offenders].sort((left, right) => {
    const [leftFile, leftLine] = left.split(':')
    const [rightFile, rightLine] = right.split(':')
    if (leftFile !== rightFile) {
      return leftFile < rightFile ? -1 : 1
    }
    return Number(leftLine) - Number(rightLine)
  })
}
