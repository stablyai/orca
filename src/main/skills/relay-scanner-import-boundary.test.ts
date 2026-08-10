import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
// TypeScript 7 is a native CLI; AST tests still need the legacy JavaScript API.
import ts from 'typescript-api'
import { describe, expect, it } from 'vitest'

/** The relay bundle imports this scanner directly; an Electron import anywhere
 *  in its transitive graph would break every deployed SSH relay. */
const RELAY_SCANNER_ENTRY = 'src/main/skills/discovery.ts'

describe('relay-bundled skill scanner boundary', () => {
  it('keeps the scanner import graph free of Electron', () => {
    const visited = new Set<string>()
    const offenders: string[] = []
    const queue = [resolve(RELAY_SCANNER_ENTRY)]
    while (queue.length > 0) {
      const file = queue.pop() as string
      if (visited.has(file)) {
        continue
      }
      visited.add(file)
      const source = readFileSync(file, 'utf8')
      for (const specifier of collectModuleSpecifiers(file, source)) {
        if (specifier === 'electron' || specifier.startsWith('electron/')) {
          offenders.push(`${file} -> ${specifier}`)
          continue
        }
        if (!specifier.startsWith('.')) {
          continue
        }
        const resolved = resolveLocalModule(dirname(file), specifier)
        if (resolved) {
          queue.push(resolved)
        }
      }
    }
    expect(offenders).toEqual([])
    expect(visited.size).toBeGreaterThan(1)
  })
})

function resolveLocalModule(fromDir: string, specifier: string): string | null {
  const base = resolve(fromDir, specifier)
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) {
    if (candidate.endsWith('.ts') || candidate.endsWith('.tsx')) {
      if (existsSync(candidate)) {
        return candidate
      }
    }
  }
  return null
}

function collectModuleSpecifiers(fileName: string, source: string): string[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true)
  const specifiers: string[] = []

  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text)
    }
    if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    ) {
      specifiers.push(node.argument.literal.text)
    }
    if (
      ts.isCallExpression(node) &&
      isModuleLoader(node.expression) &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      specifiers.push(node.arguments[0].text)
    }
    ts.forEachChild(node, visit)
  }

  visit(file)
  return specifiers
}

function isModuleLoader(expression: ts.Expression): boolean {
  return (
    expression.kind === ts.SyntaxKind.ImportKeyword ||
    (ts.isIdentifier(expression) && expression.text === 'require')
  )
}
