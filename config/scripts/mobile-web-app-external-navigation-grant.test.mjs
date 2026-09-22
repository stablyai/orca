/**
 * Which page routes render an HTML artifact, and the grant the preview needs from each of them.
 *
 * Natively the preview is its own WebView and `onShouldStartLoadWithRequest` hands every request to
 * `openExternalLink`, so there is nothing to negotiate. In the page a tap inside the sealed frame
 * becomes a top-frame navigation, and only the shell around the document can cancel it and open the
 * URL. A shell built before that event drops the navigation in silence, so
 * `use-html-preview-link-grant.web.ts` asks first (`init.grants.native`) and a route that declared
 * nothing renders the artifact's links as text.
 *
 * `externalNavigation` has no call site of the shape `mobile-web-app-page-grant-call-sites.mjs`
 * parses -- nothing is requested and nothing is answered, so there is no seam function to find --
 * which is why it belongs here beside `haptics` and `screencastBinary` rather than as a row there.
 * The screencast census's shape, against the third token that is neither a verb nor a notify.
 *
 * The lane is optional, so what this census pins is different from the required-lane ones: a route
 * missing the grant is not a native screen, it is a preview with inert links. That makes the
 * declaration easy to forget, and this is the only thing that would notice.
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
const SEAM = 'src/components/use-html-preview-link-grant.web.ts'
const NATIVE = 'src/components/use-html-preview-link-grant.ts'
/** Where the grant token is declared, so this file reads it rather than spelling it again. */
const GRANT_MODULE = 'src/mobile-web-shell/cancelled-navigation-target.ts'

/** The token, parsed off its own declaration: a second spelling is one that can drift. */
function externalNavigationGrantToken() {
  const source = readFileSync(join(mobileDir, GRANT_MODULE), 'utf8')
  const declared = /BRIDGE_EXTERNAL_NAVIGATION_GRANT = '([^']+)'/.exec(source)
  if (declared === null) {
    throw new Error(`${GRANT_MODULE} no longer declares the grant this census reads`)
  }
  return declared[1]
}

/** The modules that call the hook, which is the preview and whatever else grows one. */
function linkGrantCallers(closure) {
  return closure.local.filter((file) => {
    if (!/\.tsx?$/.test(file) || file === SEAM || file === NATIVE) {
      return false
    }
    return /\buseHtmlPreviewLinkGrant\s*\(/.test(readFileSync(join(mobileDir, file), 'utf8'))
  })
}

/** Both lanes, because the token may be declared on either and the census is about the route
 *  holding it at all. Which lane is the product call ruling 37.3 gave the desktop. */
function routesDeclaring(token) {
  return MOBILE_WEB_PAGE_ROUTES.filter(
    (route) => route.grants.includes(token) || (route.optionalGrants ?? []).includes(token)
  ).map((route) => route.pathname)
}

describe('the grant token this census is written against', () => {
  it('is the one the shell declares', () => {
    expect(externalNavigationGrantToken()).toBe('externalNavigation')
  })
})

describeClosure(
  'the routes that render an HTML artifact',
  () => {
    it('declares external navigation on exactly the routes whose closure asks for it', async () => {
      const asking = []
      for (const [route, mod] of PAGE_ROUTE_MODULES) {
        const closure = await mobileWebAppRouteClosure(mod)
        if (linkGrantCallers(closure).length > 0) {
          asking.push(route)
        }
      }
      // One route today, and the precondition an assertion about a derived set needs: an empty
      // list is also what a walk that read nothing produces. The file preview route is deliberately
      // not here -- it renders `MobileFilePreviewScreen`, which has no HTML preview in its closure.
      expect(asking).toEqual(['/h/[hostId]/session/[worktreeId]'])
      expect([...routesDeclaring(externalNavigationGrantToken())].sort()).toEqual(
        [...asking].sort()
      )
    })

    it('declares it on the optional lane, so a shell without it keeps the screen on the page', () => {
      const session = MOBILE_WEB_PAGE_ROUTES.find(
        (route) => route.pathname === '/h/[hostId]/session/[worktreeId]'
      )
      if (!session) {
        throw new Error('the manifest lost the session route this census is written against')
      }
      const token = externalNavigationGrantToken()
      expect(session.optionalGrants).toContain(token)
      // The half that matters: on the required lane this one name would take the whole session
      // screen native on every shell built before the cancelled-navigation event.
      expect(session.grants).not.toContain(token)
    })

    it('reaches the seam through its web sibling, and the caller is the preview', async () => {
      const closure = await mobileWebAppRouteClosure(
        PAGE_ROUTE_MODULES.get('/h/[hostId]/session/[worktreeId]')
      )
      expect(closure.local).toContain(SEAM)
      expect(closure.local).not.toContain(NATIVE)
      expect(linkGrantCallers(closure)).toEqual(['src/components/MobileHtmlPreview.web.tsx'])
      // The preview is mounted by the session's file reader rather than by a route of its own,
      // which is why the grant has no route to be pinned against except this one.
      expect(closure.local).toContain('src/session/MobileSessionFileReader.tsx')
      // And the inerting pass is in the closure too: without it the hook's answer would change a
      // sandbox token and leave the dead anchor ruling 37.2 forbids.
      expect(closure.local).toContain('src/components/html-preview-inert-links.ts')
    })

    it('covers every declared page route, so a new one cannot be missed by this file', () => {
      const { mapped, declared } = pageRouteModulesCoverTheManifest(MOBILE_WEB_PAGE_ROUTES)
      expect(mapped).toEqual(declared)
    })
  },
  240_000
)
