import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const fileUrl = new URL('../../app/h/[hostId]/session/[worktreeId].tsx', import.meta.url)
const source = readFileSync(fileUrl, 'utf8')
const sourceFile = ts.createSourceFile(
  fileUrl.href,
  source,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX
)

function findQuickCommandsTabButtons(): ts.JsxSelfClosingElement[] {
  const matches: ts.JsxSelfClosingElement[] = []

  function visit(node: ts.Node): void {
    if (
      ts.isJsxSelfClosingElement(node) &&
      node.tagName.getText(sourceFile) === 'QuickCommandsTabButton'
    ) {
      matches.push(node)
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return matches
}

function getQuickCommandsTabSource(): string {
  const start = source.indexOf('accessibilityLabel="New tab"')
  expect(start).toBeGreaterThanOrEqual(0)
  const end = source.indexOf('{/* Content-row host', start)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end)
}

describe('quick-commands tab stability', () => {
  it('keeps the button mounted while preserving the capability gate', () => {
    const tabSource = getQuickCommandsTabSource()
    const buttons = findQuickCommandsTabButtons()

    expect(buttons).toHaveLength(1)
    const tabBar = buttons[0].parent
    expect(ts.isJsxElement(tabBar)).toBe(true)
    if (!ts.isJsxElement(tabBar)) {
      return
    }
    expect(tabBar.openingElement.tagName.getText(sourceFile)).toBe('View')
    const style = tabBar.openingElement.attributes.properties.find(
      (attribute): attribute is ts.JsxAttribute =>
        ts.isJsxAttribute(attribute) && attribute.name.getText(sourceFile) === 'style'
    )
    expect(style?.initializer?.getText(sourceFile)).toBe('{styles.tabBar}')
    expect(tabSource).toContain('if (quickCommandsSupported === true)')
    expect(tabSource).toContain('setShowQuickCommands(true)')
    expect(tabSource).toContain('Desktop update required for quick commands')
    expect(tabSource).toContain('Checking desktop capabilities — try again in a moment')
  })

  it('only presents the sheet after support is confirmed', () => {
    expect(source).toContain('visible={showQuickCommands && quickCommandsSupported === true}')
  })
})
