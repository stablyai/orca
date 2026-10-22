// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTerminalDocumentScope } from './document-scope'
import { terminalDocumentDouble } from './document-terminal-double.test-support'
import { handleMsg } from './host-message-router'
import { stopTerminalFont } from './terminal-font'
import { defaultTerminalFontFamily } from './text-scaling'

const originalFonts = Object.getOwnPropertyDescriptor(document, 'fonts')
afterEach(() => {
  vi.unstubAllGlobals()
  if (originalFonts) {
    Object.defineProperty(document, 'fonts', originalFonts)
  } else {
    Reflect.deleteProperty(document, 'fonts')
  }
})

function fontsDouble() {
  const added = new Set<object>()
  Object.defineProperty(document, 'fonts', {
    configurable: true,
    value: { add: (face: object) => added.add(face), delete: (face: object) => added.delete(face) }
  })
  const loads: { family: string; finish: () => void }[] = []
  vi.stubGlobal(
    'FontFace',
    class {
      family: string
      constructor(family: string) {
        this.family = family
      }
      load() {
        return new Promise<this>((resolve) => {
          loads.push({ family: this.family, finish: () => resolve(this) })
        })
      }
    }
  )
  return { added, loads }
}

function scopeWithTerminal() {
  const scope = createTerminalDocumentScope({ postToHost: () => {} })
  scope.term = terminalDocumentDouble().terminal
  scope.terminalFontFamily = defaultTerminalFontFamily()
  scope.term.options.fontFamily = scope.terminalFontFamily
  return scope
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('the terminal font', () => {
  it('leads the stack with the imported face once it loads, and drops it on reset', async () => {
    const fonts = fontsDouble()
    const scope = scopeWithTerminal()
    handleMsg(scope, { type: 'set-font', font: { source: 'data:font/ttf;base64,AA==' } })
    expect(scope.term!.options.fontFamily).toBe(defaultTerminalFontFamily())
    fonts.loads[0]!.finish()
    await settle()
    expect(scope.term!.options.fontFamily).toBe(
      `"${fonts.loads[0]!.family}", ${defaultTerminalFontFamily()}`
    )
    expect(fonts.added.size).toBe(1)
    handleMsg(scope, { type: 'set-font', font: null })
    await settle()
    expect(scope.term!.options.fontFamily).toBe(defaultTerminalFontFamily())
    expect(fonts.added.size).toBe(0)
  })

  it('lets a later choice win over an earlier file that finishes loading after it', async () => {
    const fonts = fontsDouble()
    const scope = scopeWithTerminal()
    handleMsg(scope, { type: 'set-font', font: { source: 'data:font/ttf;base64,AB==' } })
    handleMsg(scope, { type: 'set-font', font: { source: 'data:font/otf;base64,AC==' } })
    fonts.loads[1]!.finish()
    await settle()
    fonts.loads[0]!.finish()
    await settle()
    expect(scope.term!.options.fontFamily).toBe(
      `"${fonts.loads[1]!.family}", ${defaultTerminalFontFamily()}`
    )
    expect(fonts.added.size).toBe(1)
    stopTerminalFont(scope)
    await settle()
    expect(fonts.added.size).toBe(0)
  })

  it('decodes one face for every pane on the page showing the same file', async () => {
    const fonts = fontsDouble()
    const first = scopeWithTerminal()
    const second = scopeWithTerminal()
    const font = { source: 'data:font/ttf;base64,AD==' }
    handleMsg(first, { type: 'set-font', font })
    handleMsg(second, { type: 'set-font', font })
    expect(fonts.loads).toHaveLength(1)
    fonts.loads[0]!.finish()
    await settle()
    expect(second.term!.options.fontFamily).toBe(first.term!.options.fontFamily)
    stopTerminalFont(first)
    await settle()
    expect(fonts.added.size).toBe(1)
    stopTerminalFont(second)
    await settle()
    expect(fonts.added.size).toBe(0)
  })
})
