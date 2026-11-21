import { describe, expect, it } from 'vitest'
import { createTerminalDocumentScope, type TerminalDocumentScope } from '../document-scope'
import { isBufferFull } from './selection-state-and-eviction'

describe('selection eviction follows the scrollback setting', () => {
  it('counts the buffer full only once the terminal scrollback and screen are written', () => {
    const scope = createTerminalDocumentScope()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the check reads only the row count and scrollback.
    scope.term = {
      rows: 24,
      options: { scrollback: 10_000 }
    } as unknown as TerminalDocumentScope['term']
    scope.linesEverWritten = 10_023
    expect(isBufferFull(scope)).toBe(false)
    scope.linesEverWritten = 10_024
    expect(isBufferFull(scope)).toBe(true)
  })
})
