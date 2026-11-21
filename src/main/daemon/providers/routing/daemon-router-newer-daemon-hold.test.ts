import { describe, expect, it, vi } from 'vitest'
import type { DaemonPtyAdapter } from '../adapter/daemon-pty-adapter'
import type {
  DaemonSessionOwnerResolution,
  DaemonSessionOwnerResolver
} from './daemon-session-owner-resolution'

vi.mock('./daemon-newer-protocol-hold', () => ({
  isHoldingForNewerProtocolDaemon: () => true,
  recheckNewerProtocolHold: async () => true
}))

const { LegacyDaemonExitProof } = await import('./daemon-legacy-exit-proof')
const { DaemonRouterHeldSpawnGate, heldSpawnRefusal, resolveHeldOwner } =
  await import('./daemon-router-newer-daemon-hold')

const SAVED = 'repo1::/tmp/feature@@d3a0a65b'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hold only probes whether the current daemon runs the saved id.
const current = {
  probesSessionDirectly: () => true,
  probePtyLiveness: async () => false
} as unknown as DaemonPtyAdapter

function gate(
  ownerResolver: DaemonSessionOwnerResolver<DaemonPtyAdapter>,
  currentDaemon: DaemonPtyAdapter = current
) {
  const exitProof = new LegacyDaemonExitProof()
  const sessionAdapters = new Map<string, DaemonPtyAdapter>()
  return new DaemonRouterHeldSpawnGate(() => ({
    sessionAdapters,
    current: currentDaemon,
    legacy: [],
    exitProof,
    ownerResolver
  }))
}

function refusal(resolution: DaemonSessionOwnerResolution<DaemonPtyAdapter>) {
  return heldSpawnRefusal(
    () => false,
    (opts) => resolveHeldOwner(opts.sessionId, resolver(resolution), [])
  )
}

function resolver(
  resolution: DaemonSessionOwnerResolution<DaemonPtyAdapter>
): DaemonSessionOwnerResolver<DaemonPtyAdapter> {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hold reads only these three.
  return {
    hasRoute: () => false,
    recordRoute: () => undefined,
    resolve: async () => resolution
  } as unknown as DaemonSessionOwnerResolver<DaemonPtyAdapter>
}

describe('a spawn while a newer daemon may still run saved sessions', () => {
  it('holds a saved id with no history instead of starting a second shell for it', async () => {
    await expect(
      gate(resolver({ kind: 'absent' })).target({ cols: 80, rows: 24, sessionId: SAVED })
    ).rejects.toThrow('terminal_held_by_newer_daemon')
    await expect(refusal({ kind: 'absent' })({ sessionId: SAVED })).rejects.toThrow(
      'terminal_held_by_newer_daemon'
    )
  })

  it('still starts a new terminal and an attach-only view', () => {
    const ownerAnswers = refusal({ kind: 'owner', provider: current })
    expect(ownerAnswers({ sessionId: SAVED, isNewSession: true })).toBeUndefined()
    expect(ownerAnswers({ sessionId: SAVED, attachOnly: true })).toBeUndefined()
  })

  it('attaches, never starts, a session the current daemon runs even when its inventory is unknown', async () => {
    const spawn = vi.fn(async () => ({ id: SAVED, isReattach: true }))
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hold probes the current daemon, then attaches through it.
    const running = {
      probesSessionDirectly: () => true,
      probePtyLiveness: async () => true,
      attachesWithoutCreating: () => true,
      spawn
    } as unknown as DaemonPtyAdapter
    const held = await gate(resolver({ kind: 'unknown' }), running).target({
      cols: 80,
      rows: 24,
      sessionId: SAVED
    })
    await held.spawn()
    expect(held.target).toBe(running)
    expect(spawn).toHaveBeenCalledWith({ cols: 80, rows: 24, sessionId: SAVED, attachOnly: true })
  })
})
