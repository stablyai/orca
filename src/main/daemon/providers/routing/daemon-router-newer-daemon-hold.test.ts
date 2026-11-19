import { describe, expect, it, vi } from 'vitest'
import type { DaemonPtyAdapter } from '../adapter/daemon-pty-adapter'
import type {
  DaemonSessionOwnerResolution,
  DaemonSessionOwnerResolver
} from './daemon-session-owner-resolution'

vi.mock('./daemon-newer-protocol-hold', () => ({ isHoldingForNewerProtocolDaemon: () => true }))

const { heldSpawnRefusal, routeSpawnOrHold } = await import('./daemon-router-newer-daemon-hold')

const SAVED = 'repo1::/tmp/feature@@d3a0a65b'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hold only compares adapter identity; it never calls one without history.
const current = { hasRestorableHistory: () => false } as unknown as DaemonPtyAdapter

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
      routeSpawnOrHold({ sessionId: SAVED }, undefined, current, resolver({ kind: 'absent' }))
    ).rejects.toThrow('terminal_held_by_newer_daemon')
    await expect(
      heldSpawnRefusal(() => resolver({ kind: 'absent' }))({ sessionId: SAVED })
    ).rejects.toThrow('terminal_held_by_newer_daemon')
  })

  it('still starts a new terminal and attaches a saved id whose owner answers', async () => {
    const owner = resolver({ kind: 'owner', provider: current })
    expect(heldSpawnRefusal(() => owner)({ sessionId: SAVED, isNewSession: true })).toBeUndefined()
    expect(heldSpawnRefusal(() => owner)({ sessionId: SAVED, attachOnly: true })).toBeUndefined()
    await expect(routeSpawnOrHold({ sessionId: SAVED }, undefined, current, owner)).resolves.toBe(
      current
    )
  })
})
