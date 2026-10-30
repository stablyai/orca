// HTML-preview links navigate top frame; only shell can cancel/open externally, unlike native WebView interception.
// Query optional externalNavigation grant first; older shells leave inert text instead of silently dropping taps or forcing whole route native.
// No request/notify call exists for call-site census, so verify route closure/declaration here.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { mobileWebAppRouteClosure } from '../build-mobile-web-app-bundle.mjs'
import { mobileWebAppDependenciesPresent } from './mobile-web-app-bundle-dependencies.mjs'
import {
  PAGE_ROUTE_MODULES,
  pageRouteModulesCoverTheManifest
} from './mobile-web-app-page-route-modules.mjs'
import { MOBILE_WEB_PAGE_ROUTES } from '../mobile-web-page-routes.mjs'

const mobileDir = fileURLToPath(new URL('../../../mobile/', import.meta.url))
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

// Count required and optional declarations; desktop ruling 37.3 chooses lane, census only proves presence.
function routesDeclaring(token) {
  return MOBILE_WEB_PAGE_ROUTES.filter(
    (route) => route.grants.includes(token) || (route.optionalGrants ?? []).includes(token)
  ).map((route) => route.pathname)
}

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
      // Require nonempty route census; file-preview route has no HTML-preview closure and intentionally stays absent.
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
      // Required grant would force entire session native on older shells; keep this optional.
      expect(session.grants).not.toContain(token)
    })

    it('reaches the seam through its web sibling, and the caller is the preview', async () => {
      const closure = await mobileWebAppRouteClosure(
        PAGE_ROUTE_MODULES.get('/h/[hostId]/session/[worktreeId]')
      )
      expect(closure.local).toContain(SEAM)
      expect(closure.local).not.toContain(NATIVE)
      expect(linkGrantCallers(closure)).toEqual(['src/components/MobileHtmlPreview.tsx'])
      // Session’s file reader mounts preview in-domain; no separate preview route owns this grant.
      expect(closure.local).toContain('src/session/MobileSessionFileReader.tsx')
      // Require inerting implementation too: sandbox-only change would leave dead anchors (ruling 37.2).
      expect(closure.local).toContain('src/components/html-preview-inert-links.ts')
    })

    it('covers every declared page route, so a new one cannot be missed by this file', () => {
      const { mapped, declared } = pageRouteModulesCoverTheManifest(MOBILE_WEB_PAGE_ROUTES)
      expect(mapped).toEqual(declared)
    })
  },
  240_000
)
