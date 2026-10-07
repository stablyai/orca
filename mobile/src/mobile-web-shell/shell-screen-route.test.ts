import { describe, expect, it } from 'vitest'
import { BRIDGE_MAX_ROUTE_PARAM_CHARS } from './bridge/bridge-caps'
import { BridgeInitRouteSchema, type BridgeInitRoute } from './bridge/bridge-envelope'
import { shellRouteHref } from './bridge/page-bootstrap'
import { shellScreenRoute, shellScreenRouteKey } from './shell-screen-route'
import {
  mobileFilePreviewShellParams,
  normalizeMobileFilePreviewRouteParams
} from '../files/mobile-file-preview-route'

const PREVIEW_PATH = '/h/host-1/files/preview/wt-1'

function previewRoute(absolutePath: string) {
  const route = normalizeMobileFilePreviewRouteParams({
    hostId: 'host-1',
    worktreeId: 'wt-1',
    source: 'terminalArtifact',
    absolutePath,
    grantId: 'grant-1'
  })
  if (!route.ok) {
    throw new Error(route.message)
  }
  return { pathname: PREVIEW_PATH, params: mobileFilePreviewShellParams(route.params) }
}

describe('the route a switch hands the shell', () => {
  it('is one the page could actually be given', () => {
    const route = previewRoute('/logs/run.txt')
    expect(BridgeInitRouteSchema.safeParse(route).success).toBe(true)
    expect(shellScreenRoute(route)).toEqual(route)
  })

  it('is nothing when a file path is longer than a param may be', () => {
    // Not hypothetical: this is the shape a Windows long path arrives in, and the first assertion
    // is what says the schema really refuses it. Without the guard the screen hands it over,
    // bridge-host drops the route to null, and the page paints "Update Orca to open this
    // workspace" over a native screen that works.
    const route = previewRoute(`/logs/${'a'.repeat(BRIDGE_MAX_ROUTE_PARAM_CHARS)}.txt`)
    expect(BridgeInitRouteSchema.safeParse(route).success).toBe(false)
    expect(shellScreenRoute(route)).toBeNull()
  })

  it('is nothing when a worktree id is not a segment the page will route', () => {
    // The C1.8 class: `..` survives encodeURIComponent, and the page resolves a dot segment out of
    // the `/h/` prefix it is supposed to stay inside.
    const route = { pathname: '/h/host-1/files/..', params: { name: 'Files' } }
    // The schema first, as the length case does: without it a `null` here would also be what a
    // guard that refused everything produces.
    expect(BridgeInitRouteSchema.safeParse(route).success).toBe(false)
    expect(shellScreenRoute(route)).toBeNull()
  })

  it('keeps a path with a slash, a space and a dot segment, which are params and not segments', () => {
    const route = {
      pathname: '/h/host-1/files/preview/wt-1',
      params: { relativePath: 'docs/../my notes/readme.md', source: 'worktree' }
    }
    expect(shellScreenRoute(route)).toEqual(route)
  })
})

describe('the key a shell screen remounts on', () => {
  /**
   * The key has to be the URL the page would end up at, because that is what it would be showing.
   * `shellRouteHref` is the page's own serializer and cannot be imported into a native route file —
   * it lives beside the page's RPC client — so the copy is pinned equal here rather than trusted.
   */
  it.each<BridgeInitRoute>([
    { pathname: '/h/host-1/files/wt-1' },
    { pathname: '/h/host-1/files/wt-1', params: { name: 'my worktree' } },
    {
      pathname: '/h/host-1/files/preview/wt-1',
      params: { relativePath: 'docs/my notes/readme.md', source: 'worktree', line: '12' }
    }
  ])('is the href the page would write into its history: %o', (route) => {
    expect(shellScreenRouteKey(route)).toBe(shellRouteHref(route))
  })
})
