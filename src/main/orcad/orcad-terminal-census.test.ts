import { describe, expect, it, vi } from 'vitest'
import { collectOrcadTerminalCensus } from './orcad-terminal-census'

describe('collectOrcadTerminalCensus', () => {
  it('counts live sessions and sessions created since activation', async () => {
    await expect(
      collectOrcadTerminalCensus(2_000, {
        listSessions: vi.fn().mockResolvedValue([{ createdAt: 1_000 }, { createdAt: 3_000 }])
      })
    ).resolves.toEqual({ liveSessions: 2, startedSinceActivation: 1 })
  })

  it('keeps post-activation inventory unverifiable for legacy timestamps', async () => {
    await expect(
      collectOrcadTerminalCensus(2_000, {
        listSessions: vi.fn().mockResolvedValue([{ createdAt: 0 }])
      })
    ).resolves.toEqual({ liveSessions: 1, startedSinceActivation: null })
  })

  it('does not infer exited sessions from a missing or failed daemon', async () => {
    await expect(collectOrcadTerminalCensus(2_000, null)).resolves.toEqual({
      liveSessions: null,
      startedSinceActivation: null
    })
    await expect(
      collectOrcadTerminalCensus(2_000, {
        listSessions: vi.fn().mockRejectedValue(new Error('lost contact'))
      })
    ).resolves.toEqual({ liveSessions: null, startedSinceActivation: null })
  })
})
