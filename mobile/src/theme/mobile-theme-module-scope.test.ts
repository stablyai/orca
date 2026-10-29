import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, relative } from 'node:path'
import ts from 'typescript-api'
import { describe, expect, it } from 'vitest'

const mobileRoot = fileURLToPath(new URL('../..', import.meta.url))
const scannedDirectories = ['src', 'app', 'web-entry']
const paletteObjects = new Set(['colors'])
// The terminal background is the same in both palettes.
const schemeIndependentKeys = new Set(['terminalBg'])

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      return entry.name === 'node_modules' ? [] : sourceFiles(path)
    }
    return /\.tsx?$/.test(entry.name) &&
      !/\.test\.tsx?$/.test(entry.name) &&
      !entry.name.endsWith('.generated.ts')
      ? [path]
      : []
  })
}

// Palette reads that run while a module loads, outside any function, keep the scheme the app started in.
function moduleScopePaletteReads(path: string): string[] {
  const source = readFileSync(path, 'utf8')
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true)
  const reads: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node) || ts.isClassLike(node)) {
      return
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      paletteObjects.has(node.expression.text) &&
      !schemeIndependentKeys.has(node.name.text)
    ) {
      const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart())
      reads.push(`${relative(mobileRoot, path)}:${line + 1} ${node.getText()}`)
    }
    // Spreading a themed stylesheet copies the scheme current at load.
    if (
      (ts.isSpreadAssignment(node) || ts.isSpreadElement(node)) &&
      ((ts.isIdentifier(node.expression) && /[sS]tyles$/.test(node.expression.text)) ||
        (ts.isCallExpression(node.expression) &&
          ts.isIdentifier(node.expression.expression) &&
          node.expression.expression.text.startsWith('themedStyle')))
    ) {
      const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart())
      reads.push(`${relative(mobileRoot, path)}:${line + 1} ${node.getText()}`)
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(sourceFile, visit)
  return reads
}

describe('mobile theme module scope', () => {
  it('reads palette colors and themed styles only while rendering or inside themedStyles', () => {
    const reads = scannedDirectories
      .flatMap((directory) => sourceFiles(join(mobileRoot, directory)))
      .flatMap(moduleScopePaletteReads)
    expect(reads).toEqual([])
  })
})
