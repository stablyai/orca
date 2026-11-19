import { describe, expect, it, vi } from 'vitest'
import type { DaemonPtyAdapter } from '../adapter/daemon-pty-adapter'
import type { DaemonSessionOwnerResolver } from './daemon-session-owner-resolution'

vi.mock('./daemon-newer-protocol-hold', () => ({ isHoldingForNewerProtocolDaemon: () => true }))

const { routeSpawnOrHold } = await import('./daemon-router-newer-daemon-hold')

const SAVED = 'repo1::/tmp/feature@@d3a0a65b'

function adapter(withHistory: boolean): DaemonPtyAdapter {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hold reads only hasRestorableHistory.
  return { hasRestorableHistory: () => withHistory } as unknown as DaemonPtyAdapter
}

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these cases never reach owner resolution.
const resolver = {} as DaemonSessionOwnerResolver<DaemonPtyAdapter>

describe('a spawn while a newer daemon may still run saved sessions', () => {
  it('starts a blank pane under a fresh id instead of the saved one the newer daemon may hold', async () => {
    const current = adapter(false)
    const routed = await routeSpawnOrHold({ sessionId: SAVED }, undefined, current, resolver)
    expect(routed.target).toBe(current)
    expect(routed.opts.sessionId).toBeUndefined()
  })

  it('keeps an id this build just minted for a new terminal', async () => {
    const routed = await routeSpawnOrHold(
      { sessionId: SAVED, isNewSession: true },
      undefined,
      adapter(false),
      resolver
    )
    expect(routed.opts.sessionId).toBe(SAVED)
  })
})
