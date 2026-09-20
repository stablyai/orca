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

/** The seam's own name, which is what a style must reach its size through. */
const SEAM_EXPORT = 'TEXT_INPUT_FONT_SIZE'

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

/** Every `styles.key` a `TextInput` names in its `style` prop, however the prop is spelled. */
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
        if (!ts.isJsxAttribute(attribute) || attribute.name.getText() !== 'style') {
          continue
        }
        const collect = (expression) => {
          if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression)) {
            refs.push({ object: expression.expression.text, key: expression.name.text })
          }
          ts.forEachChild(expression, collect)
        }
        if (attribute.initializer !== undefined) {
          collect(attribute.initializer)
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
 * The `fontSize` a style key resolves to, following a spread of another module's styles.
 *
 * The spread matters rather than being a nicety: both screens this rule was written for reach their
 * input through `{ ...baseStyles, ...listStyles }`, so a walk that stopped at the first module
 * would find no `fontSize` and call the offence absent.
 */
function fontSizeOf(mobileDir, file, exportName, key, seen = new Set()) {
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
  const spreads = []
  for (const property of object.properties) {
    if (ts.isSpreadAssignment(property) && ts.isIdentifier(property.expression)) {
      spreads.push(property.expression.text)
      continue
    }
    if (
      !ts.isPropertyAssignment(property) ||
      property.name.getText().replaceAll(/['"]/g, '') !== key ||
      !ts.isObjectLiteralExpression(property.initializer)
    ) {
      continue
    }
    for (const entry of property.initializer.properties) {
      if (ts.isPropertyAssignment(entry) && entry.name.getText() === 'fontSize') {
        return {
          file,
          text: entry.initializer.getText(),
          line: parsed.getLineAndCharacterOfPosition(entry.getStart(parsed)).line + 1
        }
      }
    }
  }
  // Later spreads win in the object, so read them in reverse.
  for (const name of spreads.toReversed()) {
    const origin = originOf(mobileDir, parsed, file, name)
    if (origin === null) {
      continue
    }
    const hit = fontSizeOf(mobileDir, origin.file, origin.name, key, seen)
    if (hit !== null) {
      return hit
    }
  }
  return null
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
  for (const file of closure.local) {
    const source = readOrNull(join(mobileDir, file))
    if (source === null || !source.includes('TextInput')) {
      continue
    }
    const parsed = parse(file, source)
    for (const { object, key } of textInputStyleRefs(parsed)) {
      const origin = originOf(mobileDir, parsed, file, object)
      if (origin === null) {
        continue
      }
      const size = fontSizeOf(mobileDir, origin.file, origin.name, key)
      if (size !== null && size.text !== SEAM_EXPORT) {
        offenders.add(`${size.file}:${size.line}`)
      }
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
