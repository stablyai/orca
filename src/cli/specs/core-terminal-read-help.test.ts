import { describe, expect, it } from 'vitest'

import { CORE_COMMAND_SPECS } from './core'
import { formatCommandHelp } from '../help'

function terminalReadHelp(): string {
  const found = CORE_COMMAND_SPECS.find((entry) => entry.path.join(' ') === 'terminal read')
  if (!found) {
    throw new Error('Missing terminal read command spec')
  }
  return formatCommandHelp(found)
}

describe('terminal read help', () => {
  // Why: agents consume --json without reading TypeScript; nextCursor vs latestCursor
  // is the field that drives paging and was previously only in the human formatter.
  it('documents the --json terminal result schema and cursor roles', () => {
    const help = terminalReadHelp()

    expect(help).toContain('With --json, the RPC result is')
    expect(help).toContain('nextCursor')
    expect(help).toContain('latestCursor')
    expect(help).toContain('oldestCursor')
    expect(help).toContain('status is running | exited | unknown')
    expect(help).toContain('Pass nextCursor to a later --cursor')
    expect(help).toContain('returnedLineCount')
  })
})
