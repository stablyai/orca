import { describe, expect, it, vi } from 'vitest'
import type { DaemonPtyAdapter } from '../adapter/daemon-pty-adapter'
import type {
  DaemonSessionOwnerResolution,
  DaemonSessionOwnerResolver
} from './daemon-session-owner-resolution'

vi.mock('./daemon-newer-protocol-hold', () => ({ isHoldingForNewerProtocolDaemon: () => true }))

const { LegacyDaemonExitProof } = await import('./daemon-legacy-exit-proof')
const { heldSpawnRefusal, resolveHeldOwner, routeSpawnOrHold } =
  await import('./daemon-router-newer-daemon-hold')

const SAVED = 'repo1::/tmp/feature@@d3a0a65b'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hold only probes whether the current daemon runs the saved id.
const current = { probePtyLiveness: async () => false } as unknown as DaemonPtyAdapter

function dispatch(ownerResolver: DaemonSessionOwnerResolver<DaemonPtyAdapter>) {
  const exitProof = new LegacyDaemonExitProof()
  return { sessionAdapters: new Map(), current, legacy: [], exitProof, ownerResolver }
}

function refusal(resolution: DaemonSessionOwnerResolution<DaemonPtyAdapter>) {
  return heldSpawnRefusal(
    () => false,
    (opts) => resolveHeldOwner(opts.sessionId, resolver(resolution))
  )
}

function resolver(
  resolution: DaemonSessionOwnerResolution<DaemonPtyAdapter>
): DaemonSessionOwnerResolver<DaemonPtyAdapter> {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hold reads only hasRoute and resolve.
  return {
    hasRoute: () => false,
    resolve: async () => resolution
  } as unknown as DaemonSessionOwnerResolver<DaemonPtyAdapter>
}

describe('a spawn while a newer daemon may still run saved sessions', () => {
  it('holds a saved id with no history instead of starting a second shell for it', async () => {
    await expect(
      routeSpawnOrHold({ sessionId: SAVED }, dispatch(resolver({ kind: 'absent' })))
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

  it('reattaches a session the current daemon runs even when its inventory answer is unknown', async () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hold only probes the current daemon.
    const running = { probePtyLiveness: async () => true } as unknown as DaemonPtyAdapter
    const router = { ...dispatch(resolver({ kind: 'unknown' })), current: running }
    await expect(routeSpawnOrHold({ sessionId: SAVED }, router)).resolves.toBe(running)
  })
})
