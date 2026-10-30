// Census every route mounting browser pane against screencastBinary grant.
// Web seam reads init.grants.native before wantsBinary; missing grant leaves live pane subscribed to a stream that never delivers frames.
// Pane has no own route; session route supplies its manifest grant.
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

const SEAM = 'src/browser/use-browser-binary-screencast-grant.web.ts'
const NATIVE = 'src/browser/use-browser-binary-screencast-grant.ts'
const GRANT_MODULE = 'src/mobile-web-shell/bridge/bridge-screencast-grant.ts'

// Read grant token from declaration to prevent duplicated spelling drifting.
function screencastGrantToken() {
  const source = readFileSync(join(mobileDir, GRANT_MODULE), 'utf8')
  const declared = /BRIDGE_SCREENCAST_BINARY_GRANT = '([^']+)'/.exec(source)
  if (declared === null) {
    throw new Error(`${GRANT_MODULE} no longer declares the grant this census reads`)
  }
  return declared[1]
}

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
      // Require nonempty route census; unresolved walk would also report no missing grants.
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
      // Session content mounts pane; there is no separate browser-pane route to own grant.
      expect(closure.local).toContain('src/session/MobileSessionActiveContent.tsx')
    })

    it('covers every declared page route, so a new one cannot be missed by this file', () => {
      const { mapped, declared } = pageRouteModulesCoverTheManifest(MOBILE_WEB_PAGE_ROUTES)
      expect(mapped).toEqual(declared)
    })
  },
  240_000
)
