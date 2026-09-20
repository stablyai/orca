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
