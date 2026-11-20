import { describe, expect, it, vi } from 'vitest'
import type { DaemonPtyAdapter } from '../adapter/daemon-pty-adapter'
import type { DaemonSessionOwnerResolver } from './daemon-session-owner-resolution'

vi.mock('./daemon-newer-protocol-hold', () => ({ isHoldingForNewerProtocolDaemon: () => true }))

const { LegacyDaemonExitProof } = await import('./daemon-legacy-exit-proof')
const { DaemonRouterHeldSpawnGate } = await import('./daemon-router-newer-daemon-hold')

// Under a hold every restored pane passes the early gate and then dispatch; a burst must probe each owner once.

const N = 200

describe('a restore burst under a newer-daemon hold', () => {
  it('probes each pane owner once across the early gate and its spawn', async () => {
    let probes = 0
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the gate only probes the current daemon here.
    const current = {
      probePtyLiveness: async () => {
        probes += 1
        return true
      }
    } as unknown as DaemonPtyAdapter
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the current daemon answers before any inventory.
    const ownerResolver = {} as DaemonSessionOwnerResolver<DaemonPtyAdapter>
    const exitProof = new LegacyDaemonExitProof()
    const gate = new DaemonRouterHeldSpawnGate(() => ({
      sessionAdapters: new Map(),
      current,
      legacy: [],
      exitProof,
      ownerResolver
    }))
    for (let i = 0; i < N; i++) {
      const opts = { sessionId: `wt@@pane-${i}` }
      await gate.refuse(opts)
      await expect(gate.target(opts)).resolves.toBe(current)
    }
    expect(probes).toBe(N)
  })
})
