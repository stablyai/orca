import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { parseMarkdownBlocks } from './markdown-blocks'

const ORIGINAL_DELIMITER = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/

function isParsedTable(delimiter: string): boolean {
  return parseMarkdownBlocks(`a|b\n${delimiter}`)[0]?.kind === 'table'
}

describe('review Markdown table delimiter cost', () => {
  it.each([
    { name: 'leading whitespace', delimiter: ' '.repeat(60_000) + 'x' },
    { name: 'trailing cell whitespace', delimiter: '-|-' + ' '.repeat(60_000) + 'x' }
  ])('rejects $name without backtracking', ({ delimiter }) => {
    // Interrupt synchronous regex regressions instead of hanging the test worker.
    const blocks = runInNewContext(
      'parse(input)',
      { parse: parseMarkdownBlocks, input: `a|b\n${delimiter}` },
      { timeout: 250 }
    )
    expect(blocks).toEqual([{ kind: 'paragraph', text: `a|b\n${delimiter}` }])
  })

  it('preserves the original delimiter grammar over generated rows', () => {
    const parts = ['', '-', '--', ':', ':-:', ':--', '--:', '|', ' ', '\t', '\r', '\\|', 'x']
    for (const left of parts) {
      for (const middle of parts) {
        for (const right of parts) {
          const row = left + middle + right
          expect(isParsedTable(row), JSON.stringify(row)).toBe(ORIGINAL_DELIMITER.test(row))
        }
      }
    }
  })
})
