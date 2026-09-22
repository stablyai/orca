import { describe, expect, it } from 'vitest'
import { parseCodexPtyStatus } from './codex-pty-status-parser'

describe('Codex PTY status parser', () => {
  it('uses the account row orientation and reset when a model-scoped weekly row renders first', () => {
    const result = parseCodexPtyStatus(
      'GPT-5.3-Codex-Spark Weekly limit: 100% left (resets in 1d 2h)\n' +
        'Weekly limit: 43% left (resets in 5d 3h)\n'
    )

    expect(result).toMatchObject({
      session: null,
      weekly: {
        usedPercent: 57,
        resetDescription: '5d 3h'
      }
    })
  })
})
