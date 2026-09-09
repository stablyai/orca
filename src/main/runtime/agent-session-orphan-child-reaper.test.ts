// A child spawned under a reservation whose record was lost is invisible to the lease. Reaping
// is bounded cleanup only; it never replaces the lease proof required to grant another writer.

import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionRecordStore } from './agent-session-record-store'
import { stopOrphanAgentSessionChildren } from './agent-session-orphan-child-reaper'

function storeWithLeasedTokens(tokens: readonly string[]) {
  return {
    listOrphanSpawnTokens: (observed: readonly string[]) =>
      observed.filter((token) => !tokens.includes(token))
  } as Pick<AgentSessionRecordStore, 'listOrphanSpawnTokens'>
}

describe('orphan agent-session child reaper', () => {
  it('stops every process whose spawn token no lease claims', async () => {
    const stop = vi.fn()

    const stopped = await stopOrphanAgentSessionChildren({
      store: storeWithLeasedTokens(['token-owned']),
      scan: async () =>
        new Map([
          ['token-owned', [101]],
          ['token-lost', [202, 203]]
        ]),
      stop
    })

    expect(stopped).toEqual([202, 203])
    expect(stop).toHaveBeenCalledWith(202, 'SIGTERM')
    expect(stop).toHaveBeenCalledWith(203, 'SIGTERM')
    expect(stop).not.toHaveBeenCalledWith(101, 'SIGTERM')
  })

  it('stops nothing on a host that cannot enumerate spawn tokens', async () => {
    const stop = vi.fn()

    // Null is "cannot answer", never "no tokens" — treating it as an empty scan would be a
    // license to signal nothing, but a future empty-map reading would be a license to signal
    // whatever the caller guessed.
    const stopped = await stopOrphanAgentSessionChildren({
      store: {
        listOrphanSpawnTokens: () => {
          throw new Error('the reaper must not ask when the host could not answer')
        }
      },
      scan: async () => null,
      stop
    })

    expect(stopped).toEqual([])
    expect(stop).not.toHaveBeenCalled()
  })

  it('surfaces a failure to signal an observed orphan', async () => {
    const failure = Object.assign(new Error('not permitted'), { code: 'EPERM' })

    await expect(
      stopOrphanAgentSessionChildren({
        store: storeWithLeasedTokens([]),
        scan: async () => new Map([['token-lost', [202]]]),
        stop: () => {
          throw failure
        }
      })
    ).rejects.toBe(failure)
  })
})
