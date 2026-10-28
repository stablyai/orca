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
  // Cursor zero is present too; reject the combination on the first page.
  it('rejects cursor zero with a screen read', () => {
    expect(() => readParams().parse({ terminal: 'term_abc', screen: true, cursor: 0 })).toThrow(
      /Cursor cannot be combined with a screen read/
    )
  })
})
