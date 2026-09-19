import { describe, expect, it } from 'vitest'
import type { DaemonPtyAdapter } from './daemon-pty-adapter'
import type { DaemonLegacyGenerationRegistryEntry } from './daemon-legacy-adapters'
import { DaemonPtyRouter } from './daemon-pty-router'
import { GIT_CREDENTIAL_GUARD_HOST_PROTOCOL_VERSION } from './types'

// Why: a minimal double, not the fuller `createAdapter()` helper in
// daemon-pty-router.test.ts — these tests only construct the router and read its
// registry accessor, never route a spawn/write/session through an adapter.
function minimalAdapter(protocolVersion: number): DaemonPtyAdapter {
  return {
    protocolVersion,
    onData: () => () => {},
    onExit: () => () => {}
  } as unknown as DaemonPtyAdapter
}

// Why: feature-request item 1 ("surface the split") needs a read-only view of what
// each legacy generation still owns, distinct from the adapter instances themselves.
// This accessor is data only: it carries no retirement or teardown capability, and
// `legacy` stays exactly as immutable as before (daemon-pty-router.ts's own comment
// on getLegacyAdapters/getCurrentAdapter, unchanged by this addition).
describe('DaemonPtyRouter legacy generation registry', () => {
  it('returns an empty array when constructed without a registry', () => {
    const current = minimalAdapter(GIT_CREDENTIAL_GUARD_HOST_PROTOCOL_VERSION + 1)
    const router = new DaemonPtyRouter({ current, legacy: [] })

    expect(router.getLegacyGenerationRegistry()).toEqual([])
  })

  it('returns the exact registry passed at construction, by reference', () => {
    const current = minimalAdapter(GIT_CREDENTIAL_GUARD_HOST_PROTOCOL_VERSION + 1)
    const legacy = minimalAdapter(GIT_CREDENTIAL_GUARD_HOST_PROTOCOL_VERSION)
    const registry: DaemonLegacyGenerationRegistryEntry[] = [
      {
        protocolVersion: GIT_CREDENTIAL_GUARD_HOST_PROTOCOL_VERSION,
        pid: 4242,
        socketPath: '/fake/daemon-v22.sock',
        sessions: [{ sessionId: 'legacy-session', busy: true }]
      }
    ]

    const router = new DaemonPtyRouter({ current, legacy: [legacy], registry })

    expect(router.getLegacyGenerationRegistry()).toBe(registry)
  })
})
