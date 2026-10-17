import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import { expect, it } from 'vitest'

const root = join(import.meta.dirname, '..')
function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory()
      ? sourceFiles(path)
      : /\.tsx?$/.test(path) && !/\.test\./.test(path)
        ? [path]
        : []
  })
}

it('does not freeze app palette values in module-level styles or constants', () => {
  const frozen: string[] = []
  for (const file of [...sourceFiles(root), ...sourceFiles(join(root, '..', 'app'))]) {
    const text = readFileSync(file, 'utf8')
    // Terminal documents receive their own host-controlled theme, independently of app chrome.
    if (
      !/import\s*\{[^}]*\b(?:colors|onBrightColors)\b[^}]*\}\s*from\s*['"][^'"]*mobile-theme['"]/.test(
        text
      )
    ) {
      continue
    }
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
    for (const statement of source.statements) {
      if (!ts.isVariableStatement(statement)) {
        continue
      }
      for (const declaration of statement.declarationList.declarations) {
        if (!declaration.initializer) {
          continue
        }
        let readsPalette = false
        const visit = (node: ts.Node) => {
          // Deferred reads use the palette active at render/document creation time.
          if (ts.isFunctionLike(node)) {
            return
          }
          if (
            ts.isPropertyAccessExpression(node) &&
            ['colors', 'onBrightColors'].includes(node.expression.getText(source))
          ) {
            readsPalette = true
          }
          ts.forEachChild(node, visit)
        }
        visit(declaration.initializer)
        if (readsPalette) {
          frozen.push(`${file}: ${declaration.name.getText(source)}`)
        }
      }
    }
  }
  expect(frozen).toEqual([])
})
