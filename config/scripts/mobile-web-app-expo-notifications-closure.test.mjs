import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'
import { describe, expect, it } from 'vitest'
import { mobileWebAppBuildOptions } from './build-mobile-web-app-bundle.mjs'
import { mobileWebAppDependenciesPresent } from './mobile-web-app-bundle-dependencies.mjs'
import { collectMobileWebAppRoutes } from './mobile-web-app-route-manifest.mjs'

/**
 * `expo-notifications`, and why no page route may import it.
 *
 * It is not a module a browser can merely import. `DevicePushTokenAutoRegistration.fx` runs at
 * import: it adds a push-token listener, which React Native Web answers with a warning and an inert
 * subscription, and it reads the persisted server registration out of `window.localStorage`. That
 * read is guarded by `typeof localStorage === 'undefined'`, and the Android shell's WebView has DOM
 * storage off, where `window.localStorage` is `null` rather than undefined — so the guard passes
 * and the read raises "Cannot read properties of null (reading 'getItem')". The emulator run saw
 * both lines on every page load, the second at error level, from a subsystem the page cannot use:
 * push registration needs a device token the shell owns and a gateway the page has no client for.
 *
 * Two modules imported it — `push-token.ts` and `desktop-notification-channel.ts`, both reached
 * through `push-registration.ts`, which `app/h/_layout.tsx` pulls in via the host screen's remove
 * action. Both now have `.web` siblings. This is the fence, because nothing else stops a third
 * importer: every call in those two files was already inert on web, so a page that imports one
 * behaves correctly and still loads the package.
 */

const projectDir = fileURLToPath(new URL('../..', import.meta.url))
const appDir = join(projectDir, 'mobile', 'app')

const describeClosure = mobileWebAppDependenciesPresent() ? describe : describe.skip

describeClosure(
  'expo-notifications against the page',
  () => {
    it('is in no module the shipped bundle contains', async () => {
      // The bundle the shell serves, not a closure read per route: the entry's manifest is what
      // reaches every route, deferred chunks included, so this is the whole of what a document
      // can load. Read per route, a module would only have to move one route over to hide.
      const routes = await collectMobileWebAppRoutes(appDir)
      expect(routes.length).toBeGreaterThan(5)
      const { metafile } = await esbuild.build({
        ...mobileWebAppBuildOptions(routes),
        metafile: true,
        write: false
      })
      const modules = Object.keys(metafile.inputs)
      expect(modules.filter((input) => input.includes('expo-notifications'))).toEqual([])
      // The precondition: a walk that resolved nothing would also contain nothing. The two modules
      // that imported it are still here, as their siblings.
      expect(modules).toContain('src/notifications/push-token.web.ts')
      expect(modules).toContain('src/notifications/desktop-notification-channel.web.ts')
    }, 300_000)
  },
  600_000
)
