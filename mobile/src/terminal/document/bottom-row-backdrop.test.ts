// @vitest-environment happy-dom
import { Terminal } from '@xterm/xterm'
import { afterEach, describe, expect, it } from 'vitest'

import { DEFAULT_TERMINAL_THEME } from '../terminal-webview-html/theme'
import { lastRowBackground } from './bottom-row-backdrop'
import { stopTerminalDocument } from './create-terminal-document'

import { createTerminalDocumentScope, type TerminalDocumentScope } from './document-scope'

const NAVY = 'rgb(14, 20, 37)'

function write(term: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve))
}

function lastRowOf(term: unknown) {
  const scope = createTerminalDocumentScope()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a real xterm terminal satisfies the document's narrower shape, which is what the scope field holds.
  scope.term = term as TerminalDocumentScope['term']
  return lastRowBackground(scope)
}

describe("xterm's own cells", () => {
  it('names a truecolor row and declines palette and inverse rows', async () => {
    const cases = [
      { name: 'truecolor', data: '\x1b[48;2;14;20;37m\x1b[K', expected: NAVY },
      { name: 'palette', data: '\x1b[42m\x1b[K', expected: null },
      { name: 'inverse', data: `\x1b[7m${' '.repeat(10)}`, expected: null },
      { name: 'mixed', data: '\x1b[48;2;14;20;37m  \x1b[0m', expected: null }
    ]
    for (const { name, data, expected } of cases) {
      const term = new Terminal({ cols: 10, rows: 4, allowProposedApi: true })
      try {
        await write(term, `\x1b[4;1H${data}`)
        expect(lastRowOf(term), name).toBe(expected)
      } finally {
        term.dispose()
      }
    }
  })

  it('reads the visible bottom row while scrolled back', async () => {
    const term = new Terminal({ cols: 10, rows: 2, scrollback: 10, allowProposedApi: true })
    try {
      await write(term, '\r\n\x1b[48;2;14;20;37m\x1b[K\x1b[0m\r\n\r\n')
      expect(lastRowOf(term)).toBe(DEFAULT_TERMINAL_THEME.background)
      term.scrollToLine(0)
      expect(lastRowOf(term)).toBe(NAVY)
    } finally {
      term.dispose()
    }
  })
})

const started: TerminalDocumentScope[] = []

afterEach(() => {
  while (started.length > 0) {
    stopTerminalDocument(started.pop()!)
  }
})
