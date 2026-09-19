import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript-api'
import { describe, expect, it } from 'vitest'

const FILES_ROOT = import.meta.dirname

/**
 * Which modules here hold a router, so the census cannot pass by seeing nothing.
 *
 * Inside the shell's page a screen is one document standing in for one screen, and `useRouteHandoff`
 * is the only thing that knows which targets the page keeps and which it hands back to the app. A
 * screen holding expo-router's own `useRouter` posts no `navigate`, so a target outside the page
 * paints Unmatched over it and a target inside it still works — which is why this is a census and
 * not a behaviour test: the failure is invisible from either screen's own tests.
 */
const ROUTER_HOLDERS = ['MobileFilePreviewScreen.tsx', 'MobileFileExplorerPanel.tsx']

function productFiles(): string[] {
  return readdirSync(FILES_ROOT, { recursive: true, encoding: 'utf8' })
    .map((entry) => entry.replaceAll('\\', '/'))
    .filter((entry) => /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry))
}

function parse(name: string): ts.SourceFile {
  return ts.createSourceFile(
    name,
    readFileSync(join(FILES_ROOT, name), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    name.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  )
}

/** Value imports only: a `import type { Href } from 'expo-router'` names no runtime router. */
function importsExpoRouterValue(source: ts.SourceFile): boolean {
  return source.statements.some((statement) => {
    if (!ts.isImportDeclaration(statement) || statement.importClause?.isTypeOnly === true) {
      return false
    }
    const specifier = statement.moduleSpecifier
    return ts.isStringLiteral(specifier) && specifier.text === 'expo-router'
  })
}

function callsRouteHandoff(source: ts.SourceFile): boolean {
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

describe('the files domain reaches the router through the handoff seam', () => {
  const files = productFiles()

  it('walks the modules it is written against', () => {
    expect(files).toEqual(expect.arrayContaining(ROUTER_HOLDERS))
  })

  it('imports no router from expo-router, which the page cannot hand a route back through', () => {
    expect(files.filter((name) => importsExpoRouterValue(parse(name)))).toEqual([])
  })

  it('takes the router from useRouteHandoff at every screen that holds one', () => {
    expect(files.filter((name) => callsRouteHandoff(parse(name))).sort()).toEqual(
      [...ROUTER_HOLDERS].sort()
    )
  })
})
