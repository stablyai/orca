import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'
import { describe, expect, it } from 'vitest'
import { mobileWebAppBuildOptions } from '../build-mobile-web-app-bundle.mjs'
import { mobileWebAppDependenciesPresent } from './mobile-web-app-bundle-dependencies.mjs'
import { collectMobileWebAppRoutes } from './mobile-web-app-route-manifest.mjs'

// Pages lack device push token/gateway: fence all src/notifications through host-removal-lifecycle.web.ts.
// expo-notifications has import-time listeners and storage reads; Android WebView returns null localStorage, bypassing undefined guard and throwing getItem.
// Keep push-token/desktop-notification-channel web siblings as a second fence against new importers; inert calls alone still load package.
// runtime-capability-probe remains allowed: status.get needs no client identity and works for session/accounts.

const projectDir = fileURLToPath(new URL('../../..', import.meta.url))
const appDir = join(projectDir, 'mobile', 'app')

const describeClosure = mobileWebAppDependenciesPresent() ? describe : describe.skip

describeClosure(
  'the push subsystem against the page',
  () => {
    it('is in no module the shipped bundle contains', async () => {
      // Read whole served bundle, including deferred routes; per-route reads could hide a module merely moved to another route.
      const routes = await collectMobileWebAppRoutes(appDir)
      expect(routes.length).toBeGreaterThan(5)
      const { metafile } = await esbuild.build({
        ...mobileWebAppBuildOptions(routes),
        metafile: true,
        write: false
      })
      const modules = Object.keys(metafile.inputs)
      // Require nonempty closure and web lifecycle resolution; empty walk or native sibling would invalidate absence evidence.
      expect(modules.length).toBeGreaterThan(1000)
      expect(modules).toContain('src/transport/host-removal-lifecycle.web.ts')
      expect(modules).not.toContain('src/transport/host-removal-lifecycle.ts')
      expect(modules.filter((input) => input.includes('expo-notifications'))).toEqual([])
      expect(modules.filter((input) => input.startsWith('src/notifications/'))).toEqual([])
    }, 300_000)
  },
  600_000
)
