import { describe, expect, it } from 'vitest'
import { TERMINAL_METHODS } from './terminal'

function readParams() {
  const method = TERMINAL_METHODS.find((candidate) => candidate.name === 'terminal.read')
  if (!method?.params) {
    throw new Error('Missing params schema for terminal.read')
  }
  return method.params
}

describe('terminal.read screen and cursor', () => {
  // Why: the CLI refuses this pair, but terminal.read is an RPC and any other caller can send
  // both. Honoring them would answer with rendered lines carrying the stream's pagination
  // metadata — two frames of reference in one payload.
  it('rejects a cursor combined with a screen read', () => {
    expect(() => readParams().parse({ terminal: 'term_abc', screen: true, cursor: 42 })).toThrow(
      /Cursor cannot be combined with a screen read/
    )
  })

  it('still accepts each on its own', () => {
    expect(readParams().parse({ terminal: 'term_abc', screen: true })).toMatchObject({
      screen: true
    })
    expect(readParams().parse({ terminal: 'term_abc', cursor: 42 })).toMatchObject({ cursor: 42 })
  })

  // Why: cursor 0 is a real cursor, not an absent one — an off-by-one here would let the
  // combination through on the first page.
  it('rejects cursor zero with a screen read', () => {
    expect(() => readParams().parse({ terminal: 'term_abc', screen: true, cursor: 0 })).toThrow(
      /Cursor cannot be combined with a screen read/
    )
  })

  it('leaves an ordinary paginated read untouched', () => {
    expect(readParams().parse({ terminal: 'term_abc', cursor: 0, limit: 100 })).toMatchObject({
      cursor: 0,
      limit: 100
    })
  })
})
