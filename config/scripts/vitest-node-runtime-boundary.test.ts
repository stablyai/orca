import { globSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript-api'
import { expect, it } from 'vitest'
import { discoverUnitFiles } from './ci-unit-files.mjs'
import { NODE_RUNTIME_INCLUDE } from './vitest-node-runtime-files.mjs'

it('runs Node runtime contracts in Node even when the coordinator uses Bun', () => {
  expect(process.versions.bun).toBeUndefined()
  expect(process.release.name).toBe('node')
  expect(Number(process.versions.node.split('.')[0])).toBeGreaterThanOrEqual(24)
})

function isGlobalThis(expression: ts.Expression): boolean {
  if (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isSatisfiesExpression(expression) ||
    ts.isNonNullExpression(expression)
  ) {
    return isGlobalThis(expression.expression)
  }
  return ts.isIdentifier(expression) && expression.text === 'globalThis'
}

it('keeps exposed-GC heap measurements in the Node runtime project', () => {
  const root = process.cwd()
  const nodeFiles = new Set(globSync(NODE_RUNTIME_INCLUDE).map((file) => resolve(root, file)))
  const missing: string[] = []
  for (const file of discoverUnitFiles(root)) {
    if (nodeFiles.has(resolve(root, file))) {
      continue
    }
    const source = readFileSync(resolve(root, file), 'utf8')
    if (!source.includes('heapUsed') || !source.includes('gc')) {
      continue
    }
    const module = ts.createSourceFile(file, source, ts.ScriptTarget.Latest)
    let usesGlobalGc = false
    const visit = (node: ts.Node): void => {
      if (
        (ts.isPropertyAccessExpression(node) &&
          node.name.text === 'gc' &&
          isGlobalThis(node.expression)) ||
        (ts.isElementAccessExpression(node) &&
          ts.isStringLiteral(node.argumentExpression) &&
          node.argumentExpression.text === 'gc' &&
          isGlobalThis(node.expression))
      ) {
        usesGlobalGc = true
      }
      ts.forEachChild(node, visit)
    }
    visit(module)
    if (usesGlobalGc) {
      missing.push(file)
    }
  }
  expect(missing).toEqual([])
})
