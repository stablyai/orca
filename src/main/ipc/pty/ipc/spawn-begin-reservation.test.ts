import { afterEach, describe, expect, it, vi } from 'vitest'
import { beginPtyIpcSpawn } from './spawn-begin'
import type { PtyIpcSpawnState } from './spawn-state'
import {
  paneSpawnReservationsByOwnerKey,
  resolvePaneSpawnReservation
} from '../pane/spawn-reservation'

vi.mock('../host-env/codex-home', () => ({ snapshotCodexPaneHomeRoutes: () => [] }))
vi.mock('../pane/stable-owner', () => ({ resolveStablePaneOwner: () => null }))
vi.mock('../provider/registry', () => ({ getAppPtyId: (_connection: unknown, id: string) => id }))

function createState(connectionId?: string): PtyIpcSpawnState {
  return {
    args: {
      tabId: 'tab-1',
      leafId: '44444444-4444-4444-8444-444444444444',
      worktreeId: 'wt-1',
      command: 'claude --resume existing-session',
      connectionId
    },
    deps: { resolvePtySpawnStartupCwd: () => '/workspace' }
  } as unknown as PtyIpcSpawnState
}

afterEach(() => {
  paneSpawnReservationsByOwnerKey.clear()
  vi.useRealTimers()
})

describe('stable-pane admission during a pending spawn', () => {
  it.each([undefined, 'ssh-1'])(
    'joins an unresolved owner on %s instead of resuming twice',
    async (connectionId) => {
      vi.useFakeTimers()
      const owner = createState(connectionId)
      await expect(beginPtyIpcSpawn(owner)).resolves.toBeNull()
      const retry = createState(connectionId)
      let retrySettled = false
      const retryResult = beginPtyIpcSpawn(retry).then((result) => {
        retrySettled = true
        return result
      })

      await vi.advanceTimersByTimeAsync(10 * 60_000)
      expect(retrySettled).toBe(false)
      expect(paneSpawnReservationsByOwnerKey.size).toBe(1)
      expect(retry.paneSpawnReservation).toBeUndefined()

      resolvePaneSpawnReservation(owner.paneSpawnReservationKey, owner.paneSpawnReservation, {
        id: 'original-pty'
      })
      await expect(retryResult).resolves.toEqual({ id: 'original-pty', isReattach: true })
      expect(paneSpawnReservationsByOwnerKey.size).toBe(0)
    }
  )
})
