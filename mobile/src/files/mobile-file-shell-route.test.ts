import { describe, expect, it } from 'vitest'
import { BRIDGE_MAX_ROUTE_PARAM_CHARS } from '../mobile-web-shell/bridge/bridge-caps'
import { BridgeInitRouteSchema } from '../mobile-web-shell/bridge/bridge-envelope'
import { mobileFileShellRoute } from './mobile-file-shell-route'
import {
  mobileFilePreviewShellParams,
  normalizeMobileFilePreviewRouteParams
} from './mobile-file-preview-route'

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

describe('the route the files screens hand the shell', () => {
  it('is one the page could actually be given', () => {
    const route = previewRoute('/logs/run.txt')
    expect(BridgeInitRouteSchema.safeParse(route).success).toBe(true)
    expect(mobileFileShellRoute(route)).toEqual(route)
  })

  it('is nothing when a file path is longer than a param may be', () => {
    // Not hypothetical: this is the shape a Windows long path arrives in, and the first assertion
    // is what says the schema really refuses it. Without the guard the screen hands it over,
    // bridge-host drops the route to null, and the page paints "Update Orca to open this
    // workspace" over a native screen that works.
    const route = previewRoute(`/logs/${'a'.repeat(BRIDGE_MAX_ROUTE_PARAM_CHARS)}.txt`)
    expect(BridgeInitRouteSchema.safeParse(route).success).toBe(false)
    expect(mobileFileShellRoute(route)).toBeNull()
  })

  it('is nothing when a worktree id is not a segment the page will route', () => {
    // The C1.8 class: `..` survives encodeURIComponent, and the page resolves a dot segment out of
    // the `/h/` prefix it is supposed to stay inside.
    expect(
      mobileFileShellRoute({ pathname: '/h/host-1/files/..', params: { name: 'Files' } })
    ).toBeNull()
  })

  it('keeps a path with a slash, a space and a dot segment, which are params and not segments', () => {
    const route = {
      pathname: '/h/host-1/files/preview/wt-1',
      params: { relativePath: 'docs/../my notes/readme.md', source: 'worktree' }
    }
    expect(mobileFileShellRoute(route)).toEqual(route)
  })
})
