// @vitest-environment happy-dom
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { Terminal } from '@xterm/xterm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTerminalDocumentScope, type TerminalDocumentScope } from '../document-scope'
import { seedWordSelection } from './selection-range'

const terminals: Terminal[] = []

afterEach(() => {
  terminals.splice(0).forEach((term) => term.dispose())
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
})
