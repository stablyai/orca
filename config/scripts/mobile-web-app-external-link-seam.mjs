/**
 * The external-link seam, and how a census recognises a module that went around it.
 *
 * Shared by every page route's census rather than restated in each: two spellings of one rule
 * drift, and the half that stops being enforced is the half nobody reads again.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript-api'

/** The seam, as the web build resolves it: `.web.ts` wins under the builder's resolveExtensions,
 *  and it is the one module a page closure may reach react-native's `Linking` from. */
export const EXTERNAL_LINK_SEAM = 'src/platform/external-link.web.ts'

/**
 * Every line on which a module reaches react-native's own `Linking`, by name or through a
 * namespace import.
 *
 * Parsed rather than matched: a regex over the text names `Linking` inside a comment that talks
 * about it and inside a string that quotes it, and a census that reports a line nobody can act on
 * is one the next reader learns to ignore. The parser also settles the quote styles for free.
 *
 * A named import reports the import statement, once however many times the module calls through
 * it, because the import is the thing the rule is about and the thing that has to go. The imported
 * name is what counts, not the local one: `import { Linking as NativeLinking }` is the same import
 * spelled differently, and reading only the binding let it through.
 *
 * A namespace import reports its uses instead, there being no single line to name — `import * as RN
 * from 'react-native'` is not itself an offence — and every alias is read, because a module may
 * import the namespace twice and call on either. A default import is read the same way: this
 * project's interop settings accept `import RN from 'react-native'` (checked with tsc), so it is a
 * binding the whole namespace hangs off exactly as `* as RN` is.
 *
 * A re-export is reported at the export statement. `export { Linking } from 'react-native'` puts
 * the name back in reach of anything that imports this module, and so does `export *`, which
 * carries it along with everything else; the statement is the line to delete, exactly as an import
 * is.
 *
 * Lines rather than a boolean because a red census that names `path:line` is read once, and one
 * that names a file is grepped for. The boolean below is derived from this, so there is one rule.
 *
 * `fileName` decides the script kind, and the default is only for callers holding a source with no
 * path. In a `.ts` file `const id = <T>(value: T) => value` is a generic arrow; parsed as TSX it is
 * an unclosed JSX element, and everything after it — a later `RN.Linking.openURL` included — is
 * swallowed into the error node and never walked.
 */
export function reactNativeLinkingSites(source, fileName = 'module.tsx') {
  // No explicit script kind: TypeScript reads it off the extension, which is the whole point.
  const parsed = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true)
  const lineOf = (node) => parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1
  const sites = []
  const aliases = new Set()
  const fromReactNative = (statement) =>
    statement.moduleSpecifier !== undefined &&
    ts.isStringLiteral(statement.moduleSpecifier) &&
    statement.moduleSpecifier.text === 'react-native'
  /** `propertyName` is the exported/imported name when the clause renames it, `name` when it does not. */
  const namesLinking = (elements) =>
    elements.some((element) => (element.propertyName ?? element.name).text === 'Linking')
  for (const statement of parsed.statements) {
    if (ts.isExportDeclaration(statement) && fromReactNative(statement)) {
      const clause = statement.exportClause
      // No clause is `export *`, which carries `Linking` with everything else; a namespace export
      // hands the whole module over under one name. Both put it back in reach.
      if (clause === undefined || ts.isNamespaceExport(clause) || namesLinking(clause.elements)) {
        sites.push(lineOf(statement))
      }
      continue
    }
    if (!ts.isImportDeclaration(statement) || !fromReactNative(statement)) {
      continue
    }
    const clause = statement.importClause
    if (clause === undefined) {
      continue
    }
    if (clause.name !== undefined) {
      aliases.add(clause.name.text)
    }
    const bindings = clause.namedBindings
    if (bindings === undefined) {
      continue
    }
    if (ts.isNamespaceImport(bindings)) {
      aliases.add(bindings.name.text)
      continue
    }
    if (namesLinking(bindings.elements)) {
      sites.push(lineOf(statement))
    }
  }
  if (aliases.size > 0) {
    const visit = (node) => {
      if (
        ts.isPropertyAccessExpression(node) &&
        ts.isIdentifier(node.expression) &&
        aliases.has(node.expression.text) &&
        node.name.text === 'Linking'
      ) {
        // The line, not the expression: two aliases meeting on one line are one site.
        sites.push(lineOf(node))
      }
      ts.forEachChild(node, visit)
    }
    ts.forEachChild(parsed, visit)
  }
  return [...new Set(sites)].sort((left, right) => left - right)
}

/** Whether a module reaches react-native's own `Linking`. */
export function reachesReactNativeLinking(source, fileName = 'module.tsx') {
  return reactNativeLinkingSites(source, fileName).length > 0
}

/**
 * Every module in a route's closure that can reach a URL without the seam, as `path:line`.
 *
 * The line is where the name enters the module, not where it is used: a named import is reported
 * once however many times the module calls `Linking.openURL`, because the import is what the rule
 * is about and what has to go. Only a namespace import reports its uses, there being no single
 * line to name — `import * as RN from 'react-native'` is not itself an offence.
 *
 * Here rather than beside each census: three copies of this walk existed before the source-control
 * routes wanted a fourth, and the seam's own module is where the rule they share belongs. A file
 * the closure names but this checkout cannot read is not an offender — the closure reports paths
 * relative to `mobile/`, and one outside it is read by its caller, not guessed at here.
 */
export function externalLinkOffenders(mobileDir, closure) {
  return (
    closure.local
      .filter((file) => file !== EXTERNAL_LINK_SEAM)
      .flatMap((file) => {
        let source
        try {
          source = readFileSync(join(mobileDir, file), 'utf8')
        } catch {
          return []
        }
        // The path, so the parser takes the script kind from the extension rather than assuming TSX.
        return reactNativeLinkingSites(source, file).map((line) => [file, line])
      })
      // By path, then by line as a number: sorting the rendered strings puts `:10` before `:2`, and
      // a red list is read top to bottom against the file it names.
      .sort(([leftFile, leftLine], [rightFile, rightLine]) =>
        leftFile === rightFile ? leftLine - rightLine : leftFile < rightFile ? -1 : 1
      )
      .map(([file, line]) => `${file}:${line}`)
  )
}
