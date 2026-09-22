import { describe, expect, it } from 'vitest'
import { formatTerminalRead } from './terminal-format'

describe('formatTerminalRead draft separation', () => {
  it('labels composer drafts outside terminal output', () => {
    const output = formatTerminalRead({
      terminal: {
        handle: 'term_1',
        status: 'running',
        tail: ['Build passed', '❯'],
        truncated: false,
        nextCursor: null,
        source: 'screen',
        draft: 'proceed with the release'
      }
    })

    expect(output).toContain('draft: "proceed with the release"')
    expect(output).toContain('\n\nBuild passed\n❯')
  })
})
