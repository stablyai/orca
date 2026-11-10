import { describe, expect, it } from 'vitest'
import {
  CACHED,
  CACHED_BELOW_HOST_FLOOR,
  MANIFEST_WIRE,
  awaitingManifest,
  gates,
  manifestFacts,
  run,
  BUNDLE_REFUSED,
  withoutRecord
} from './mobile-web-shell-session-test-fixtures'

// Refused updates should fall back to intact cached bytes under their own routes/grants, as offline entry does, while respecting any reachable host’s compatibility window.
describe('an update this shell refused falls back to the generation that already works', () => {
  // Change assets and grants so the new manifest cannot safely authorize the old bytes.
  const NEWER = manifestFacts({
    ...MANIFEST_WIRE,
    buildId: 'c'.repeat(64),
    routes: [{ pathname: '/h/[hostId]', grants: ['navigate', 'storage'] }]
  })

  function refused() {
    return run(
      awaitingManifest(CACHED).session,
      { type: 'manifest-read', manifest: NEWER },
      { type: 'download-failed', cause: BUNDLE_REFUSED }
    )
  }

  it('runs it under its own grants, not the ones the refused manifest declared', () => {
    expect(refused().session.routeGrants).toEqual(['navigate'])
  })

  it('walls the cached generation the host has moved past rather than serving it', () => {
    // Unlike offline fallback, this reachable host can have moved outside the cached bundle’s compatibility window.
    const step = run(
      run(awaitingManifest(CACHED_BELOW_HOST_FLOOR).session, {
        type: 'manifest-read',
        manifest: NEWER
      }).session,
      { type: 'download-failed', cause: BUNDLE_REFUSED }
    )
    expect(step.session.state).toEqual({
      kind: 'wall',
      verdict: {
        kind: 'blocked',
        reason: 'bundle-incompatible',
        side: 'mobile',
        bundleRuntimeProtocolVersion: 0,
        requiredBundleRuntimeProtocolVersion: 1
      }
    })
    expect(withoutRecord(step.effects)).toEqual([])
  })
})

// Gates can change during fetching; fallback must use their current verdict, including recoverable unreadable status, instead of inventing another decision.
describe('the fallback answers each gate verdict the way the rest of the shell does', () => {
  const NEWER = manifestFacts({ ...MANIFEST_WIRE, buildId: 'c'.repeat(64) })

  function refusedUnder(patch: Parameters<typeof gates>[0], cached = CACHED) {
    const fetching = run(awaitingManifest(cached).session, {
      type: 'manifest-read',
      manifest: NEWER
    })
    const moved = run(fetching.session, { type: 'gates-changed', gates: gates(patch) })
    return run(moved.session, { type: 'download-failed', cause: BUNDLE_REFUSED })
  }

  it('says the status could not be read rather than serving a generation it cannot judge', () => {
    const step = refusedUnder({ statusReadable: false, hostCapabilities: [] })
    expect(step.session.state).toEqual({
      kind: 'failed',
      reason: 'status-unreadable',
      retriedOnce: false
    })
    expect(run(step.session, { type: 'gates-changed', gates: gates() }).effects).toEqual([
      { kind: 'open-cache' }
    ])
  })
})
