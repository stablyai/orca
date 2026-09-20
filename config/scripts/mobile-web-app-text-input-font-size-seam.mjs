/**
 * The text-input font-size seam, and how a census finds an input that went around it.
 *
 * `src/platform/text-input-font-size.web.ts` raises the app's body size to the floor below which
 * iOS zooms the page on focus. That zoom is what `keyboard-occlusion.web.ts` reads as "not a
 * keyboard", so one 14px input left in a page route's closure is enough to put a typing session at
 * a scale other than 1 and stop the commit bar and the note composer lifting for the rest of it.
 * A rule per route closure rather than per known site: the first fix covered two inputs and eight
 * others in the same closures still carried the old size.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript-api'

export const TEXT_INPUT_FONT_SIZE_SEAM = 'src/platform/text-input-font-size.web.ts'

/** The seam's own name, and the module it has to come from. */
const SEAM_EXPORT = 'TEXT_INPUT_FONT_SIZE'
const SEAM_MODULE = 'src/platform/text-input-font-size.ts'

const parse = (file, source) => ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)

function readOrNull(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/** A relative specifier as a path under `mobile/`, or null for a package. */
function resolveLocal(mobileDir, fromFile, specifier) {
  if (!specifier.startsWith('.')) {
    return null
  }
  const base = resolve(dirname(join(mobileDir, fromFile)), specifier)
  for (const extension of ['.ts', '.tsx', '/index.ts', '/index.tsx']) {
    if (existsSync(base + extension)) {
      // Relative to the root rather than sliced by its length, which leaves a leading separator
      // whenever the root is passed without a trailing one.
      return relative(mobileDir, base + extension).replaceAll('\\', '/')
    }
  }
  return null
}

/**
 * The style expressions one `style` prop really applies, flattened.
 *
 * A prop is rarely one thing: `[styles.input, disabled && styles.disabled]` is the common shape in
 * this tree, and both members can reach the element. So arrays, spreads, `&&`, `?:` and parentheses
 * are followed to the expressions that can actually land, rather than walked as a blob — a subtree
 * walk would also descend into an inline literal's own properties and read them as style keys.
 *
 * A branch that contributes nothing when taken (`null`, `undefined`, `false`) is dropped: it is not
 * a style the walk failed to follow.
 */
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
    // Either branch can be the one that renders.
    return [...styleExpressions(expression.whenTrue), ...styleExpressions(expression.whenFalse)]
  }
  if (ts.isBinaryExpression(expression)) {
    const kind = expression.operatorToken.kind
    if (kind === ts.SyntaxKind.AmpersandAmpersandToken) {
      // The left side is the condition, not a style.
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

/**
 * Every style one `TextInput` applies, as something the rule can answer for.
 *
 * Three shapes, because a shape that is none of them has to be visible rather than dropped: a
 * `styles.key` reference to follow, an inline object literal to read in place, and anything else —
 * a call, a bare identifier, an expression this walk does not model — which is a hole and belongs
 * in the unresolved list.
 */
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
        // The element's line, so a ref names where its input sits.
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

/** Where a local name was declared: this file, or the module it came in from. */
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

/**
 * Whether a `fontSize` initializer is the seam's export, by binding rather than by spelling.
 *
 * Matching the text accepts `const TEXT_INPUT_FONT_SIZE = 14` two lines up, and an import of the
 * same name from any other module — both of which are exactly the regression the seam exists to
 * stop, wearing its name.
 */
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
        resolveLocal(mobileDir, file, statement.moduleSpecifier.text) === SEAM_MODULE
      ) {
        return true
      }
    }
  }
  return false
}

/** The declaration `name` binds in this file, if it has one. */
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

/** The object literal a style declaration ends in, through `StyleSheet.create(...)`. */
function styleObjectOf(initializer) {
  if (initializer === null) {
    return null
  }
  if (ts.isObjectLiteralExpression(initializer)) {
    return initializer
  }
  if (ts.isCallExpression(initializer) && initializer.arguments.length > 0) {
    const first = initializer.arguments[0]
    return ts.isObjectLiteralExpression(first) ? first : null
  }
  return null
}

/**
 * What a style key resolves to, following a spread of another module's styles.
 *
 * Three answers, not two. `null` is "this key is nowhere I could follow", which is a hole in the
 * walk rather than a clean input; `{ size: null }` is a key that exists and sets no size, which
 * inherits and is nothing to answer for. Collapsing the two would let a resolution failure read as
 * a passing input, which is how a census like this goes quietly vacuous.
 *
 * The spread matters rather than being a nicety: both screens this rule was written for reach their
 * input through `{ ...baseStyles, ...listStyles }`, so a walk that stopped at the first module
 * would find no `fontSize` and call the offence absent.
 */
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
  // Reverse source order, direct keys and spreads together: the last thing that mentions the key
  // is what the object ends up holding, so `{ input: safe, ...legacy }` answers with legacy's.
  // Scanning direct keys first answered `safe` and called the override clean.
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

/** The `fontSize` a style object literal declares, with whether it came through the seam. */
function fontSizeIn(mobileDir, parsed, file, object) {
  for (const entry of object.properties) {
    if (ts.isPropertyAssignment(entry) && entry.name.getText() === 'fontSize') {
      return {
        file,
        text: entry.initializer.getText(),
        line: parsed.getLineAndCharacterOfPosition(entry.getStart(parsed)).line + 1,
        onSeam: isSeamBinding(mobileDir, parsed, file, entry.initializer)
      }
    }
  }
  return null
}

/** Every `TextInput` style reference in a closure, with what the walk made of it. */
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
        // Resolved in place: the literal is its own declaration, so there is nothing to follow.
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

/**
 * Every `TextInput` style this walk could not follow to a declaration, as `path:line`.
 *
 * The completeness half of the rule below: an offender list is only evidence that every input is on
 * the seam if every input was read. A style reached through a package, a helper call or a shape
 * this walk does not model lands here instead of passing silently.
 */
export function unresolvedTextInputStyles(mobileDir, closure) {
  return textInputStyleResolutions(mobileDir, closure)
    .filter((entry) => entry.resolved === null)
    .map((entry) => `${entry.at} (${entry.key})`)
    .sort()
}

/**
 * Every text input in a closure whose size does not come through the seam, as `path:line`.
 *
 * A style with no `fontSize` is not an offender: it inherits, and the floor is about the size an
 * input declares. The line named is where the size is set, which is the line to change, and it may
 * be in a different module from the `TextInput` that uses it.
 */
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
