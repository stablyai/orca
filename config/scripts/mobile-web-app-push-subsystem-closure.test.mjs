import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'
import { describe, expect, it } from 'vitest'
import { mobileWebAppBuildOptions } from './build-mobile-web-app-bundle.mjs'
import { mobileWebAppDependenciesPresent } from './mobile-web-app-bundle-dependencies.mjs'
import { collectMobileWebAppRoutes } from './mobile-web-app-route-manifest.mjs'

/**
 * The push subsystem, and why no page route may reach any part of it.
 *
 * Not `runtime-capability-probe.ts`, which `push-registration.ts` also imported: the session
 * route reaches it through `use-mobile-session-tab-reconciliation.ts` and the host screen through
 * `codex-reset-credit-capability.ts`, and both of those run on the page. It left the C1 layout
 * closure with push and stayed in the bundle, which is why it is pinned nowhere here.
 *
 * `expo-notifications` first, and why no page route may import it.
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
 * through `push-registration.ts`, which `app/h/_layout.tsx` pulled in via the host screen's remove
 * action. Both were given `.web` siblings. That was the first fence, and it is kept because
 * nothing else stops a third importer: every call in those two files was already inert on web, so
 * a page that imports one behaves correctly and still loads the package.
 *
 * `push-registration.ts` is fenced a layer up, and that is what the assertions below read. The
 * page cannot register for push at all: it has no device token and no gateway client, so every
 * path through that module either does nothing or writes `orca:remotePushHostRegistrations`
 * through a page storage adapter that drops the write and says so. `host-removal-lifecycle.web.ts`
 * is what cut it out — removing a host is native-only — and it took the whole of
 * `src/notifications` with it, because that import was the only path into the directory from any
 * page route. So the fence is stated as the directory rather than as three module names: the two
 * `.web` siblings above are no longer in the page bundle either, and a test that asserted their
 * presence as its precondition would now be asserting the fence had a hole.
 */

const projectDir = fileURLToPath(new URL('../..', import.meta.url))
const appDir = join(projectDir, 'mobile', 'app')

const describeClosure = mobileWebAppDependenciesPresent() ? describe : describe.skip

describeClosure(
  'the push subsystem against the page',
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
      // The precondition, because a walk that resolved nothing would also contain nothing, and one
      // that ignored `.web` resolution would report the native lifecycle file rather than the
      // sibling whose refusal is the reason push is absent.
      expect(modules.length).toBeGreaterThan(1000)
      expect(modules).toContain('src/transport/host-removal-lifecycle.web.ts')
      expect(modules).not.toContain('src/transport/host-removal-lifecycle.ts')
      expect(modules.filter((input) => input.includes('expo-notifications'))).toEqual([])
      expect(modules.filter((input) => input.startsWith('src/notifications/'))).toEqual([])
    }, 300_000)
  },
  600_000
)
