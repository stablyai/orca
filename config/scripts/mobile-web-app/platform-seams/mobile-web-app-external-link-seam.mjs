// Share external-link census across routes so duplicated rule implementations cannot drift.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript-api'

// Web seam is sole permitted page-closure importer of native Linking; builder selects .web.ts sibling.
export const EXTERNAL_LINK_SEAM = 'src/platform/external-link.web.ts'

// Parse real Linking bindings, excluding strings/comments and recognizing named aliases plus namespace/default interop.
// Report named imports/reexports once at entry statement; report namespace property uses, since whole namespace import is allowed.
// Reexport * also exposes Linking. Deduplicate path/line for actionable diagnostics.
// Infer parser kind from filename: TSX parsing of TS generic arrows can swallow later RN.Linking uses into error node.
export function reactNativeLinkingSites(source, fileName = 'module.tsx') {
  const parsed = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true)
  const lineOf = (node) => parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1
  const sites = []
  const aliases = new Set()
  const fromReactNative = (statement) =>
    statement.moduleSpecifier !== undefined &&
    ts.isStringLiteral(statement.moduleSpecifier) &&
    statement.moduleSpecifier.text === 'react-native'
  const namesLinking = (elements) =>
    elements.some((element) => (element.propertyName ?? element.name).text === 'Linking')
  for (const statement of parsed.statements) {
    if (ts.isExportDeclaration(statement) && fromReactNative(statement)) {
      const clause = statement.exportClause
      // Export * and namespace export both make Linking reachable to downstream imports.
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
        // Deduplicate by line when multiple aliases meet at one site.
        sites.push(lineOf(node))
      }
      ts.forEachChild(node, visit)
    }
    ts.forEachChild(parsed, visit)
  }
  return [...new Set(sites)].sort((left, right) => left - right)
}

export function reachesReactNativeLinking(source, fileName = 'module.tsx') {
  return reactNativeLinkingSites(source, fileName).length > 0
}

// Report route-closure native Linking entries as path:line, excluding permitted seam.
// Missing mobile-relative files may be external modules read by caller; do not guess them here.
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
        return reactNativeLinkingSites(source, file).map((line) => [file, line])
      })
      // Sort line numbers numerically so :2 precedes :10 within each path.
      .sort(([leftFile, leftLine], [rightFile, rightLine]) =>
        leftFile === rightFile ? leftLine - rightLine : leftFile < rightFile ? -1 : 1
      )
      .map(([file, line]) => `${file}:${line}`)
  )
}
