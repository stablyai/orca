import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript-api'

/**
 * How a domain census reads which of its modules hold a router, and where each one got it.
 *
 * Inside the shell's page a screen is one document standing in for one screen, and
 * `useRouteHandoff` is the only thing that knows which targets the page keeps and which it hands
 * back to the app. A screen holding expo-router's own `useRouter` posts no `navigate`, so a target
 * outside the page paints Unmatched over it and a target inside it still works — which is why this
 * is a census and not a behaviour test: the failure is invisible from either screen's own tests.
 *
 * Shared by every domain that runs it rather than copied per domain: C3.1 wrote this walk for the
 * files tree and the source-control tree wanted the same four rules, and two spellings of one rule
 * drift apart in exactly the half nobody reads again.
 */

/** Every product module under a domain root, as paths relative to it. */
export function productFiles(root: string): string[] {
  return readdirSync(root, { recursive: true, encoding: 'utf8' })
    .map((entry) => entry.replaceAll('\\', '/'))
    .filter((entry) => /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry))
}

export function parse(root: string, name: string): ts.SourceFile {
  return ts.createSourceFile(
    name,
    readFileSync(join(root, name), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    name.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  )
}

/** Value imports only: an `import type { Href } from 'expo-router'` names no runtime router. */
export function importsExpoRouterValue(source: ts.SourceFile): boolean {
  return source.statements.some((statement) => {
    if (!ts.isImportDeclaration(statement) || statement.importClause?.isTypeOnly === true) {
      return false
    }
    const specifier = statement.moduleSpecifier
    return ts.isStringLiteral(specifier) && specifier.text === 'expo-router'
  })
}

export function callsRouteHandoff(source: ts.SourceFile): boolean {
  let found = false
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'useRouteHandoff'
    ) {
      found = true
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(source, visit)
  return found
}

/**
 * Every value name a module imports from expo-router, so a domain can say which ones it allows.
 *
 * The two landed censuses answer "no value import at all", which is the right rule for a domain
 * whose only reach into expo-router is a router. The session domain's is not: eight of its hooks
 * take `useFocusEffect` and two take `useLocalSearchParams`, neither of which can navigate, and a
 * blanket rule there would have to be turned off rather than narrowed.
 *
 * Names rather than a boolean for `useRouter`, because the hazard is the category and not the one
 * spelling of it: `import { router }` is expo-router's module singleton and navigates from anywhere,
 * and a rule written against `useRouter` alone would have read it as clean.
 *
 * The imported name, not the local one: `import { useRouter as useAppRouter }` is the same import.
 */
export function expoRouterValueImports(source: ts.SourceFile): string[] {
  const names = new Set<string>()
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || statement.importClause?.isTypeOnly === true) {
      continue
    }
    const specifier = statement.moduleSpecifier
    if (!ts.isStringLiteral(specifier) || specifier.text !== 'expo-router') {
      continue
    }
    const bindings = statement.importClause?.namedBindings
    if (bindings !== undefined && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        if (element.isTypeOnly) {
          continue
        }
        names.add((element.propertyName ?? element.name).text)
      }
    }
    // A default or namespace import hands the whole module over under one name, router included.
    if (statement.importClause?.name !== undefined) {
      names.add('default')
    }
    if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
      names.add('*')
    }
  }
  return [...names].sort()
}
