// @vitest-environment happy-dom
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { Terminal } from '@xterm/xterm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTerminalDocumentScope, type TerminalDocumentScope } from '../document-scope'
import { seedWordSelection } from './selection-range'

const terminals: Terminal[] = []

afterEach(() => {
  terminals.splice(0).forEach((term) => term.dispose())
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

async function fixture(text: string) {
  const term = new Terminal({ cols: 60, rows: 3, allowProposedApi: true })
  terminals.push(term)
  term.loadAddon(new Unicode11Addon())
  term.unicode.activeVersion = '11'
  await new Promise<void>((resolve) => term.write(text, resolve))
  const scope = createTerminalDocumentScope()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the real xterm exposes the narrower document terminal API.
  scope.term = term as unknown as TerminalDocumentScope['term']
  const select = vi.spyOn(term, 'select').mockImplementation(() => {})
  const selected = () => {
    const [col, row, length] = select.mock.calls.at(-1)!
    return term.buffer.active.getLine(row)?.translateToString(false, col, col + length)
  }
  return { term, scope, select, selected }
}

describe('word selection uses the rendered xterm cell range', () => {
  it('keeps cell mapping when a legacy WebView has no grapheme segmenter', async () => {
    const f = await fixture('합성 🙂 cafe\u0301')
    vi.stubGlobal('Intl', Object.assign(Object.create(Intl), { Segmenter: undefined }))
    seedWordSelection(f.scope, 3, 0)
    expect(f.select).toHaveBeenLastCalledWith(0, 0, 4)
    expect(f.selected()).toBe('합성')
    seedWordSelection(f.scope, 6, 0)
    expect(f.select).toHaveBeenLastCalledWith(5, 0, 2)
    expect(f.selected()).toBe('🙂')
  })

  it('keeps an absolute scrollback row and tolerates an evicted line', async () => {
    const f = await fixture('한글\r\nsecond\r\nthird\r\nfourth')
    expect(f.term.buffer.active.viewportY).toBeGreaterThan(0)
    seedWordSelection(f.scope, 2, 0)
    expect(f.select).toHaveBeenLastCalledWith(0, 0, 4)
    expect(f.selected()).toBe('한글')
    seedWordSelection(f.scope, 2, 99)
    expect(f.select).toHaveBeenLastCalledWith(2, 99, 1)
  })
})

describe('Unicode selection boundaries across every rendered column', () => {
  it.each([
    ['한글', 4],
    ['cafe\u0301', 4],
    ['𐐀x', 2],
    ['👍🏽', 4],
    ['👨‍👩‍👧‍👦', 8],
    ['🏳️‍🌈', 3],
    ['🇰🇷', 2],
    ['❤️', 1]
  ] as const)('keeps %s whole at each of its %i cells after wide text', async (text, width) => {
    const f = await fixture(`가 ${text} next`)
    for (let col = 3; col < 3 + width; col++) {
      seedWordSelection(f.scope, col, 0)
      expect(f.select).toHaveBeenLastCalledWith(3, 0, width)
      expect(f.selected()).toBe(text)
    }
    seedWordSelection(f.scope, 3 + width + 1, 0)
    expect(f.selected()).toBe('next')
  })

  it('keeps the last wide word on the row and the next wrapped row independent', async () => {
    const f = await fixture(' '.repeat(56) + '한글next')
    for (const col of [56, 57, 58, 59]) {
      seedWordSelection(f.scope, col, 0)
      expect(f.select).toHaveBeenLastCalledWith(56, 0, 4)
      expect(f.selected()).toBe('한글')
    }
    seedWordSelection(f.scope, 0, 1)
    expect(f.select).toHaveBeenLastCalledWith(0, 1, 4)
    expect(f.selected()).toBe('next')
  })
})
