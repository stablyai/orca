/**
 * The media-picker seam, and how a census recognises a module that went around it.
 *
 * `expo-image-picker` and `expo-document-picker` are native modules: importing either runs a
 * codegen lookup that throws in a browser, and the route manifest imports every route, so one such
 * import takes the whole page down rather than one picker. `expo-clipboard`'s `getImageAsync` is
 * the third way in and fails differently — it resolves on the web to a `navigator.clipboard` read
 * that needs a secure context, which the iOS shell's custom scheme is not.
 *
 * Shared by the censuses rather than restated in each, for the external-link seam's reason: two
 * spellings of one rule drift, and the half that stops being enforced is the half nobody reads.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript-api'

/** The seam, as the web build resolves it: `.web.ts` wins under the builder's resolveExtensions. */
export const MEDIA_PICKER_SEAM = 'src/platform/media-picker.web.ts'

/** The two module specifiers a page closure may not contain at all. */
export const NATIVE_PICKER_MODULES = ['expo-image-picker', 'expo-document-picker']

const CLIPBOARD_MODULE = 'expo-clipboard'
const CLIPBOARD_IMAGE_READ = 'getImageAsync'

/**
 * Every line on which a module reaches a native picker or the pasteboard's image.
 *
 * Parsed rather than matched, for the reason the external-link census parses: a regex over the text
 * names `expo-image-picker` inside the comment that explains why it is not imported, and a census
 * reporting a line nobody can act on is one the next reader learns to ignore.
 *
 * A picker import is reported at the import statement whatever its clause, side-effect imports
 * included, because the module's own top level is what throws — nothing has to be called. A
 * re-export is the same statement in the other direction and is reported too.
 *
 * `expo-clipboard` is not banned: writing and reading text are the clipboard seam's and legitimate
 * in this closure. Only the image read is an offence, so a named import of `getImageAsync` is
 * reported at its import, and a namespace or default binding reports the lines that read the
 * property off it — `import * as Clipboard from 'expo-clipboard'` is not itself an offence.
 *
 * `fileName` decides the script kind, and the default is only for a caller holding a source with no
 * path: in a `.ts` file `const id = <T>(v: T) => v` is a generic arrow, and parsed as TSX it is an
 * unclosed JSX element that swallows everything after it into an error node.
 */
export function mediaPickerSites(source, fileName = 'module.tsx') {
  const parsed = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true)
  const lineOf = (node) => parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1
  const sites = []
  const clipboardAliases = new Set()
  const specifierOf = (statement) =>
    statement.moduleSpecifier !== undefined && ts.isStringLiteral(statement.moduleSpecifier)
      ? statement.moduleSpecifier.text
      : null
  /**
   * `propertyName` is the imported or destructured name when the clause renames it, `name` when it
   * does not. A binding element's `name` may be a nested pattern rather than an identifier and a
   * `propertyName` may be computed, so the text is read only off a node that has one.
   */
  const namesImageRead = (elements) =>
    elements.some((element) => {
      const named = element.propertyName ?? element.name
      return (
        (ts.isIdentifier(named) || ts.isStringLiteral(named)) && named.text === CLIPBOARD_IMAGE_READ
      )
    })

  /** A declaration reading straight off one of the module's aliases: `const x = Clipboard`. */
  const declaredFromAlias = (node) =>
    ts.isVariableDeclaration(node) &&
    node.initializer !== undefined &&
    ts.isIdentifier(node.initializer) &&
    clipboardAliases.has(node.initializer.text)

  for (const statement of parsed.statements) {
    const specifier =
      ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)
        ? specifierOf(statement)
        : null
    if (specifier === null) {
      continue
    }
    if (NATIVE_PICKER_MODULES.includes(specifier)) {
      sites.push(lineOf(statement))
      continue
    }
    if (specifier !== CLIPBOARD_MODULE) {
      continue
    }
    if (ts.isExportDeclaration(statement)) {
      const clause = statement.exportClause
      // No clause is `export *`, which carries `getImageAsync` along with everything else.
      if (clause === undefined || ts.isNamespaceExport(clause) || namesImageRead(clause.elements)) {
        sites.push(lineOf(statement))
      }
      continue
    }
    const clause = statement.importClause
    if (clause === undefined) {
      continue
    }
    if (clause.name !== undefined) {
      clipboardAliases.add(clause.name.text)
    }
    const bindings = clause.namedBindings
    if (bindings === undefined) {
      continue
    }
    if (ts.isNamespaceImport(bindings)) {
      clipboardAliases.add(bindings.name.text)
      continue
    }
    if (namesImageRead(bindings.elements)) {
      sites.push(lineOf(statement))
    }
  }

  /**
   * The same two modules reached through `import()`, which the static scan above cannot see.
   *
   * A dynamic import with a literal specifier is a module the bundler resolves and puts in the
   * closure exactly as a static one, so a picker behind `await import('expo-image-picker')` takes
   * the page down the same way. `await` and parentheses are unwrapped because they are punctuation
   * around the call rather than a different call; a specifier that is not a literal is left alone,
   * for the reason a computed key is.
   */
  const dynamicImportOf = (node) => {
    let value = node
    while (ts.isAwaitExpression(value) || ts.isParenthesizedExpression(value)) {
      value = value.expression
    }
    if (
      !ts.isCallExpression(value) ||
      value.expression.kind !== ts.SyntaxKind.ImportKeyword ||
      value.arguments.length === 0
    ) {
      return null
    }
    const [specifier] = value.arguments
    return ts.isStringLiteral(specifier) || ts.isNoSubstitutionTemplateLiteral(specifier)
      ? specifier.text
      : null
  }

  const seedDynamic = (node) => {
    if (ts.isVariableDeclaration(node) && node.initializer !== undefined) {
      const specifier = dynamicImportOf(node.initializer)
      if (specifier === CLIPBOARD_MODULE) {
        if (ts.isIdentifier(node.name)) {
          clipboardAliases.add(node.name.text)
        } else if (ts.isObjectBindingPattern(node.name) && namesImageRead(node.name.elements)) {
          sites.push(lineOf(node))
        }
      }
    }
    // The picker modules need no alias: reaching one at all is the offence, wherever it lands.
    if (ts.isCallExpression(node)) {
      const specifier = dynamicImportOf(node)
      if (specifier !== null && NATIVE_PICKER_MODULES.includes(specifier)) {
        sites.push(lineOf(node))
      }
    }
    ts.forEachChild(node, seedDynamic)
  }
  ts.forEachChild(parsed, seedDynamic)

  if (clipboardAliases.size > 0) {
    /**
     * Every further name the module is reachable under, to a fixpoint.
     *
     * `const pasteboard = Clipboard` makes `pasteboard` the module too, and the chain has no
     * length limit. A fixpoint rather than one pass in source order, because the rule is about
     * what the module can be reached as and not about the order a reader arrives in.
     */
    for (let grew = true; grew;) {
      grew = false
      const learn = (node) => {
        if (
          declaredFromAlias(node) &&
          ts.isIdentifier(node.name) &&
          !clipboardAliases.has(node.name.text)
        ) {
          clipboardAliases.add(node.name.text)
          grew = true
        }
        ts.forEachChild(node, learn)
      }
      ts.forEachChild(parsed, learn)
    }

    /**
     * `Clipboard.getImageAsync` and `Clipboard['getImageAsync']` are the same call.
     *
     * Element access with a literal key is the spelling a minifier and a bundler both produce and
     * the one a reader reaches for to get around a rule about dots. Quoted or backticked: a
     * template with no substitution is a string literal with a different quote, and reading only
     * one of the two would leave the other as the way around this rule. A key with a substitution
     * or an identifier in it is not read, because its value is not in the source and guessing would
     * report a line nobody can act on.
     */
    const readsImageOffAlias = (node) => {
      if (!ts.isIdentifier(node.expression) || !clipboardAliases.has(node.expression.text)) {
        return false
      }
      if (ts.isPropertyAccessExpression(node)) {
        return node.name.text === CLIPBOARD_IMAGE_READ
      }
      const key = node.argumentExpression
      return (
        key !== undefined &&
        (ts.isStringLiteral(key) || ts.isNoSubstitutionTemplateLiteral(key)) &&
        key.text === CLIPBOARD_IMAGE_READ
      )
    }

    const visit = (node) => {
      if (
        (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
        readsImageOffAlias(node)
      ) {
        sites.push(lineOf(node))
      }
      // `const { getImageAsync } = Clipboard` reaches the same function without ever writing the
      // property access above. A census that read only the access approved the closure while that
      // call died on the browser clipboard API. Reported at the declaration, which is the line to
      // delete.
      if (
        declaredFromAlias(node) &&
        ts.isObjectBindingPattern(node.name) &&
        namesImageRead(node.name.elements)
      ) {
        sites.push(lineOf(node))
      }
      ts.forEachChild(node, visit)
    }
    ts.forEachChild(parsed, visit)
  }
  return [...new Set(sites)].sort((left, right) => left - right)
}

/**
 * Every module in a closure that can pick media without the seam, as `path:line`.
 *
 * A file the closure names but this checkout cannot read is not an offender: the closure reports
 * paths relative to `mobile/`, and one outside it is the caller's to read rather than guessed at.
 */
export function mediaPickerOffenders(mobileDir, closure) {
  return closure.local
    .filter((file) => file !== MEDIA_PICKER_SEAM)
    .flatMap((file) => {
      let source
      try {
        source = readFileSync(join(mobileDir, file), 'utf8')
      } catch {
        return []
      }
      // The path, so the parser takes the script kind from the extension rather than assuming TSX.
      return mediaPickerSites(source, file).map((line) => [file, line])
    })
    .sort(([leftFile, leftLine], [rightFile, rightLine]) =>
      leftFile === rightFile ? leftLine - rightLine : leftFile < rightFile ? -1 : 1
    )
    .map(([file, line]) => `${file}:${line}`)
}
