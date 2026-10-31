import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript-api'

// Share import checks across domains: direct Expo routers bypass bridge handoff in embedded pages, a failure isolated screen tests cannot observe.

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

// Type-only imports expose no runtime router.
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

// Return imported value names so domains can allow non-navigation hooks while rejecting routers, including aliased/singleton forms.
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
    // Default/namespace imports expose the router too.
    if (statement.importClause?.name !== undefined) {
      names.add('default')
    }
    if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
      names.add('*')
    }
  }
  return [...names].sort()
}
