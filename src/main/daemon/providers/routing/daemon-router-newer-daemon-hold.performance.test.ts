import { describe, expect, it, vi } from 'vitest'
import type { DaemonPtyAdapter } from '../adapter/daemon-pty-adapter'
import type { DaemonSessionOwnerResolver } from './daemon-session-owner-resolution'

vi.mock('./daemon-newer-protocol-hold', () => ({
  isHoldingForNewerProtocolDaemon: () => true,
  recheckNewerProtocolHold: () => true
}))

const { LegacyDaemonExitProof } = await import('./daemon-legacy-exit-proof')
const { DaemonRouterHeldSpawnGate } = await import('./daemon-router-newer-daemon-hold')

// Under a hold every restored pane passes the early gate and then dispatch; a burst must probe each owner once.

const N = 200

describe('a restore burst under a newer-daemon hold', () => {
  it('probes each pane owner once across the early gate and its spawn', async () => {
    let probes = 0
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the gate only probes the current daemon here.
    const current = {
      probesSessionDirectly: () => true,
      probePtyLiveness: async () => {
        probes += 1
        return true
      }
    } as unknown as DaemonPtyAdapter
    const sessionAdapters = new Map<string, DaemonPtyAdapter>()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: every probe answers, so no inventory is read.
    const ownerResolver = {} as DaemonSessionOwnerResolver<DaemonPtyAdapter>
    const exitProof = new LegacyDaemonExitProof()
    const gate = new DaemonRouterHeldSpawnGate(() => ({
      sessionAdapters,
      current,
      legacy: [],
      exitProof,
      ownerResolver
    }))
    const panes = Array.from({ length: N }, (_, i) => ({
      cols: 80,
      rows: 24,
      sessionId: `wt@@pane-${i}`
    }))
    await Promise.all(panes.map((opts) => gate.refuse(opts)))
    for (const opts of panes) {
      await expect(gate.target(opts)).resolves.toMatchObject({ target: current })
    }
    expect(probes).toBe(N)
  })
})
