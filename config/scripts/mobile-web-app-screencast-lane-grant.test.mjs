/**
 * Which page routes mount the browser pane, and the grant the pane needs from each of them.
 *
 * Natively the socket carries the screencast's binary frames and the app is both halves of that
 * path, so there is nothing to negotiate. In the page the frames come through a shell that may
 * predate the encoder, and the pane asks first: `use-browser-binary-screencast-grant.web.ts` reads
 * `init.grants.native`, and a route that did not declare `screencastBinary` subscribes without
 * `wantsBinary` — a live pane on a stream no frame arrives on, with nothing on screen to say why.
 *
 * C6 could not write this census: the pane is mounted by a route rather than registered as one, so
 * there was no route to pin the grant against (C6 ruling 3 deferred it to C7). The session route is
 * that route, and this is the general rule rather than an entry for it — the haptics seam census's
 * shape, against the other grant a shared component brings into a closure.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { mobileWebAppRouteClosure } from './build-mobile-web-app-bundle.mjs'
import { mobileWebAppDependenciesPresent } from './mobile-web-app-bundle-dependencies.mjs'
import {
  PAGE_ROUTE_MODULES,
  pageRouteModulesCoverTheManifest
} from './mobile-web-app-page-route-modules.mjs'
import { MOBILE_WEB_PAGE_ROUTES } from './mobile-web-page-routes.mjs'

const mobileDir = fileURLToPath(new URL('../../mobile/', import.meta.url))
const describeClosure = mobileWebAppDependenciesPresent() ? describe : describe.skip

/** The seam as the web build resolves it, and the native sibling the page must never reach. */
const SEAM = 'src/browser/use-browser-binary-screencast-grant.web.ts'
const NATIVE = 'src/browser/use-browser-binary-screencast-grant.ts'
/** Where the grant token is declared, so this file reads it rather than spelling it again. */
const GRANT_MODULE = 'src/mobile-web-shell/bridge/bridge-screencast-grant.ts'

/** The token, parsed off its own declaration: a second spelling is one that can drift. */
function screencastGrantToken() {
  const source = readFileSync(join(mobileDir, GRANT_MODULE), 'utf8')
  const declared = /BRIDGE_SCREENCAST_BINARY_GRANT = '([^']+)'/.exec(source)
  if (declared === null) {
    throw new Error(`${GRANT_MODULE} no longer declares the grant this census reads`)
  }
  return declared[1]
}

/** The modules that call the hook, which is the pane and whatever else grows one. */
function screencastGrantCallers(closure) {
  return closure.local.filter((file) => {
    if (!/\.tsx?$/.test(file) || file === SEAM || file === NATIVE) {
      return false
    }
    return /\buseBrowserBinaryScreencastGrant\s*\(/.test(
      readFileSync(join(mobileDir, file), 'utf8')
    )
  })
}

describe('the grant token this census is written against', () => {
  it('is the one the shell declares', () => {
    expect(screencastGrantToken()).toBe('screencastBinary')
  })
})

describeClosure(
  'the routes that mount the browser pane',
  () => {
    it('declares the screencast lane on exactly the routes whose closure asks for it', async () => {
      const asking = []
      for (const [route, mod] of PAGE_ROUTE_MODULES) {
        const closure = await mobileWebAppRouteClosure(mod)
        if (screencastGrantCallers(closure).length > 0) {
          asking.push(route)
        }
      }
      // One route today, and the precondition an assertion about a derived set needs: an empty
      // list is also what a walk that read nothing produces.
      expect(asking).toEqual(['/h/[hostId]/session/[worktreeId]'])
      const declared = MOBILE_WEB_PAGE_ROUTES.filter((route) =>
        route.grants.includes(screencastGrantToken())
      ).map((route) => route.pathname)
      expect([...declared].sort()).toEqual([...asking].sort())
    })

    it('reaches the seam through its web sibling, and the caller is the pane', async () => {
      const closure = await mobileWebAppRouteClosure(
        PAGE_ROUTE_MODULES.get('/h/[hostId]/session/[worktreeId]')
      )
      expect(closure.local).toContain(SEAM)
      expect(closure.local).not.toContain(NATIVE)
      expect(screencastGrantCallers(closure)).toEqual(['src/browser/MobileBrowserPane.tsx'])
      // The pane is mounted by the session's content row rather than by a route of its own, which
      // is the whole reason this grant had no route to be pinned against until now.
      expect(closure.local).toContain('src/session/MobileSessionActiveContent.tsx')
    })

    it('covers every declared page route, so a new one cannot be missed by this file', () => {
      const { mapped, declared } = pageRouteModulesCoverTheManifest(MOBILE_WEB_PAGE_ROUTES)
      expect(mapped).toEqual(declared)
    })
  },
  240_000
)
