import { describe, expect, it } from 'vitest'
import {
  MANIFEST,
  afterCacheRead,
  createMobileWebShellSession,
  gates,
  run
} from './mobile-web-shell-session-test-fixtures'

const UNLISTED_WALL = { kind: 'wall', verdict: { kind: 'blocked', reason: 'page-route-unlisted' } }

describe('a manifest whose page does not serve this route walls instead of going native', () => {
  it('walls the desktop as too old for a route the bundle does not list', () => {
    const step = run(afterCacheRead(null).session, {
      type: 'manifest-read',
      manifest: { ...MANIFEST, routes: [{ pathname: '/h/[hostId]/tasks', grants: [] }] }
    })
    expect(step.session.state).toEqual(UNLISTED_WALL)
    expect(step.effects).toEqual([])
  })

  it('walls this app as too old for a route listed with a grant it does not implement', () => {
    const step = run(afterCacheRead(null).session, {
      type: 'manifest-read',
      manifest: {
        ...MANIFEST,
        routes: [{ pathname: '/h/[hostId]', grants: ['navigate', 'teleport'] }]
      }
    })
    expect(step.session.state).toEqual({
      kind: 'wall',
      verdict: { kind: 'blocked', reason: 'page-route-grant-missing' }
    })
    expect(step.effects).toEqual([])
  })

  it('walls the desktop as too old when it predates the routes field itself', () => {
    const step = run(afterCacheRead(null).session, {
      type: 'manifest-read',
      manifest: { ...MANIFEST, routes: undefined }
    })
    expect(step.session.state).toEqual(UNLISTED_WALL)
  })

  it('answers the compat wall before the route, since an unreadable schema hides the route list', () => {
    const step = run(afterCacheRead(null).session, {
      type: 'manifest-read',
      manifest: { ...MANIFEST, schemaVersion: 99, routes: [] }
    })
    expect(step.session.state).toEqual({
      kind: 'wall',
      verdict: { kind: 'blocked', reason: 'bundle-shell-too-old', schemaVersion: 99 }
    })
  })

  it('walls a page below the floor as it is, whatever routes it lists', () => {
    const step = run(afterCacheRead(null).session, {
      type: 'manifest-read',
      manifest: { ...MANIFEST, pageVersion: 0, routes: [] }
    })
    expect(step.session.state).toMatchObject({
      kind: 'wall',
      verdict: { reason: 'bundle-incompatible', side: 'desktop', pageVersion: 0 }
    })
  })

  it('says the screen is unavailable, not the desktop too old, for a pathname this app has no screen for', () => {
    const opened = run(
      createMobileWebShellSession('/h/host-1/insights', false, false),
      { type: 'gates-changed', gates: gates() },
      { type: 'cache-read', generation: null }
    )
    const step = run(opened.session, { type: 'manifest-read', manifest: MANIFEST })
    expect(step.session.state).toEqual({ kind: 'route-unavailable' })
  })

  it('says the screen is unavailable when the manifest carries a pattern this shell cannot read', () => {
    const step = run(afterCacheRead(null).session, {
      type: 'manifest-read',
      manifest: { ...MANIFEST, routes: [{ pathname: '/h/[...a]/[...b]', grants: [] }] }
    })
    expect(step.session.state).toEqual({ kind: 'route-unavailable' })
  })

  it('keeps that answer across a layout flip, which rebuilds the session', () => {
    const opened = run(
      createMobileWebShellSession('/h/host-1/insights', false, false),
      { type: 'gates-changed', gates: gates() },
      { type: 'cache-read', generation: null },
      { type: 'manifest-read', manifest: MANIFEST }
    )
    expect(run(opened.session, { type: 'layout-changed', wide: true }).session.appNamesRoute).toBe(
      false
    )
  })
})
