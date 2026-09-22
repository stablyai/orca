import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium } from 'playwright-core'
import { buildMobileWebAppBundle } from './build-mobile-web-app-bundle.mjs'
import { mobileWebAppDependenciesPresent } from './mobile-web-app-bundle-dependencies.mjs'
import { MOBILE_WEB_PAGE_ROUTES } from './mobile-web-page-routes.mjs'
import {
  createBundleServer,
  installShellDouble,
  readBridgeFaultGrant,
  readBridgeProtocolVersion,
  readShellCsp
} from './mobile-web-app-render-harness.mjs'

/**
 * The session route in a real browser, on the bundle the shell would serve, under its own header.
 *
 * What only a browser answers for this route: that every module in the largest closure of the
 * series imports and evaluates under React Native Web, that the route paints the session screen
 * rather than the Unmatched route, that its chunk arrives over the wire on a client-side
 * navigation, and that nothing it paints leaves the origin or violates the policy. The unit tests
 * cannot say any of it, because they mock react-native away — it is Flow source vitest will not
 * parse.
 *
 * Two defects this file found, both invisible natively and both a console line rather than a crash,
 * and both now fixed:
 *
 * - `use-mobile-session-markdown-actions.ts` registered `BackHandler` with no platform guard, and
 *   the effect re-registers whenever the dirty-draft list changes. React Native Web answers with
 *   "BackHandler is not supported on web and should not be used." and an inert subscription: two
 *   lines on the console at mount, and a hardware-back guard never armed anyway.
 * - `use-mobile-session-diff-comments.ts` ran `void loadDiffComments()` in an effect with no catch.
 *   The loader returns on a *refused* `worktree.show` and nothing caught a *rejected* one, so a
 *   host that will not answer raised an unhandled rejection on every session mount. `.catch` at the
 *   effect is the fix, and it moved a golden: the corpus certified the rejection as an effect of the
 *   loaded checkpoint, so `matrix-session.diff-notes-worktree.show-1` was re-recorded without it.
 *
 * So the error assertion below is an exact empty list rather than a filter: nothing from this
 * closure reaches the document, and any error at all reds it.
 *
 * **The terminal is not painted here, and this file must not look as though it is.** Putting a
 * terminal on screen needs the host protocol handshake, a tab snapshot, a terminal inventory and a
 * `terminal.subscribe` stream, which is five hand-written fixtures against five Zod schemas inside
 * a transport double — the thing the harness's own docstring says it must not become. What the
 * terminal does under the shipped header, opening xterm with zero CSP violations and a byte-exact
 * transcript, is `mobile-web-app-terminal-render.test.mjs`, which drives the same component on the
 * same build options through a probe route. The rest of what this file does not claim is at the
 * bottom.
 */

const HOST_ROUTE = '/h/render-check-host'
const WORKTREE = 'wt-1'
const SESSION_ROUTE = `${HOST_ROUTE}/session/${WORKTREE}`
const SESSION_PATTERN = '/h/[hostId]/session/[worktreeId]'
/** The patterns `init.pageRoutes` names, which is what the page matches a navigation against. */
const PAGE_ROUTE_PATTERNS = ['/h/[hostId]', SESSION_PATTERN]
const SHELL_SESSION_ID = 'session-render-session'
const SHELL_BUILD_ID = 'session-render-build'
const SHELL_HOST = {
  id: 'render-check-host',
  name: 'Render Check Host',
  endpoint: 'ws://render-check',
  lastConnected: 1
}
const UNMATCHED = 'Unmatched Route'
const SESSION_CHUNK_KEY = './h/[hostId]/session/[worktreeId].tsx'

/**
 * Exactly what the route declares, read off the manifest rather than restated.
 *
 * The page's own seams are gated on these: a list written by hand here would let the route grow a
 * grant this check never exercises, which is the case where a control renders and refuses.
 */
function sessionGrants() {
  const declared = MOBILE_WEB_PAGE_ROUTES.find((route) => route.pathname === SESSION_PATTERN)
  if (!declared) {
    throw new Error(`${SESSION_PATTERN} is not registered`)
  }
  return declared.grants
}

const bundles = mobileWebAppDependenciesPresent()
const describeRender = bundles ? describe : describe.skip

let scratch
let server
let browser
let origin
let routeChunks = {}
let servedPaths = []
let cspHeader = null
let bridgeVersion = null
let faultGrant = null

beforeAll(async () => {
  if (!bundles) {
    return
  }
  cspHeader = await readShellCsp()
  bridgeVersion = await readBridgeProtocolVersion()
  faultGrant = await readBridgeFaultGrant()
  scratch = await mkdtemp(join(tmpdir(), 'orca-mobile-web-app-session-'))
  const built = await buildMobileWebAppBundle({ outDir: join(scratch, 'bundle') })
  routeChunks = built.routeChunks
  const served = await createBundleServer({ outDir: built.outDir, cspHeader })
  server = served.server
  origin = served.origin
  servedPaths = served.requestedPaths
  const executablePath = process.env.ORCA_MOBILE_WEB_RENDER_BROWSER
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) })
}, 240_000)

afterAll(async () => {
  await browser?.close()
  server?.close()
  if (scratch) {
    await rm(scratch, { recursive: true, force: true })
  }
})

/** A page carrying every signal these cases read: uncaught errors, console errors, request paths. */
async function openPage(route, replies = {}, { domStorageOff = false } = {}) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
  if (domStorageOff) {
    // What the Android shell serves: DOM storage is off on its WebView, and a WebView with it off
    // answers `window.localStorage` with `null` rather than leaving it undefined. Read off the
    // device rather than assumed — the emulator run's own error names `null` (reading 'getItem').
    await page.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', { configurable: true, get: () => null })
    })
  }
  // At document start, where the native shell installs the real channel: the entry reads it while
  // its own script runs, so a channel added after `load` would already be too late.
  await page.addInitScript(installShellDouble, {
    version: bridgeVersion,
    sessionId: SHELL_SESSION_ID,
    buildId: SHELL_BUILD_ID,
    route: { pathname: route },
    host: SHELL_HOST,
    storage: {},
    faultGrant,
    grants: [faultGrant, ...sessionGrants()],
    pageRoutes: PAGE_ROUTE_PATTERNS,
    replies
  })
  const errors = []
  const warnings = []
  const scripts = []
  const requestedHosts = []
  page.on('pageerror', (error) => errors.push(`${error.name}: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error') {
      errors.push(`console.error: ${message.text()}`)
    }
    // Kept apart from `errors`: the bridge reports a refused storage write at warning level, so a
    // page writing a key it was never handed is invisible to every assertion above.
    if (message.type() === 'warning') {
      warnings.push(message.text())
    }
  })
  // Every request, not only the ones that answered: a CSP refusal fails the request, and a check
  // reading responses alone would read a blocked fetch as one that never happened.
  page.on('request', (request) => requestedHosts.push(new URL(request.url()).host))
  page.on('response', (response) => {
    const path = new URL(response.url()).pathname
    if (response.status() === 200 && path.endsWith('.js')) {
      scripts.push(path)
    }
  })
  return { page, errors, warnings, scripts, requestedHosts }
}

/**
 * Wait for the entry to mount and then for the route's own content, polled rather than read once:
 * every screen is deferred behind `import()`, so `mounted` lands while the chunk is still arriving.
 */
async function waitForRoute({ page, errors }, route, awaitText) {
  const named = (what) =>
    new Error(`${route} ${what}: ${errors.join(' | ') || 'no page or console error'}`)
  try {
    await page.waitForFunction(() => document.documentElement.dataset.orcaWebEntry === 'mounted', {
      timeout: 60_000,
      polling: 250
    })
  } catch {
    throw named('never mounted')
  }
  try {
    await page.waitForFunction((needle) => document.body.innerText.includes(needle), awaitText, {
      timeout: 60_000,
      polling: 250
    })
  } catch {
    throw named(`mounted but never painted ${JSON.stringify(awaitText)}`)
  }
  // A route that threw under the page's own error boundary names itself here rather than timing
  // out as a page that never mounted.
  for (const fault of await page.evaluate(() => globalThis.__orcaRenderCheckFaults ?? [])) {
    errors.push(`page fault: ${fault}`)
  }
}

async function openRoute(route, awaitText, replies = {}, options = {}) {
  const opened = await openPage(route, replies, options)
  await opened.page.goto(`${origin}/`, { waitUntil: 'load' })
  await waitForRoute(opened, route, awaitText)
  return opened
}

/** The session header renders it, so the chrome is on screen before this reads the tree. */
const BACK_LABEL = 'Back to worktrees'

describeRender(
  'the session route in a real browser',
  () => {
    it('mounts the session screen rather than the unmatched route, with nothing on the console', async () => {
      const opened = await openRoute(SESSION_ROUTE, 'Terminal')
      const text = await opened.page.evaluate(() => document.body.innerText)
      // The command dock's own keys, which is the session screen and not a header that happens to
      // say the word: no other page route renders an accessory bar.
      for (const key of ['Esc', 'Tab', 'Ctrl+C', 'Ctrl+R']) {
        expect(text).toContain(key)
      }
      expect(text).not.toContain(UNMATCHED)
      // Exact, because this closure's defects are exactly console lines: the unguarded
      // `BackHandler` put two here and the uncaught diff-notes rejection one, and both are fixed.
      expect(opened.errors).toEqual([])
      await opened.page.close()
    }, 120_000)

    it('puts the Back control in the accessibility tree by name', async () => {
      // Inside the shell there is no native chrome behind this control, so a bare Pressable is
      // absent from the tree: a screen reader has nothing to announce and the device proof has
      // nothing to find. The source census
      // (`mobile/src/mobile-web-shell/page-served-back-control-a11y.test.ts`) holds the role and
      // the wording; this is the half only a browser answers, that the two reach the rendered DOM.
      const opened = await openRoute(SESSION_ROUTE, 'Terminal')
      const control = await opened.page.evaluate((label) => {
        const found = document.querySelector(`[aria-label="${label}"]`)
        return found === null ? null : { role: found.getAttribute('role'), tag: found.tagName }
      }, BACK_LABEL)
      // A real `<button>`, which is what React Native Web emits for `accessibilityRole="button"`
      // and what carries the name into the tree. Without the role it renders a `div` with the
      // label and no role at all, so this is the assertion the role earns.
      expect(control).toEqual({ role: 'button', tag: 'BUTTON' })
      await opened.page.close()
    }, 120_000)

    it("fetches the session route's own chunk on a client-side navigation", async () => {
      const opened = await openRoute(HOST_ROUTE, SHELL_HOST.name)
      const loadedForFirstRoute = [...opened.scripts]
      await opened.page.evaluate((to) => {
        history.pushState(null, '', to)
        dispatchEvent(new PopStateEvent('popstate'))
      }, SESSION_ROUTE)
      await waitForRoute(opened, SESSION_ROUTE, 'Terminal')
      const chunk = routeChunks[SESSION_CHUNK_KEY]
      expect(chunk, Object.keys(routeChunks).join(' ')).toBeTruthy()
      // Named by the builder rather than guessed from the bytes: this is what says the route came
      // over the wire now and not out of what the first route had already loaded.
      expect(opened.scripts.filter((path) => !loadedForFirstRoute.includes(path))).toContain(
        `/assets/${chunk}`
      )
      expect(loadedForFirstRoute).not.toContain(`/assets/${chunk}`)
      await opened.page.close()
    }, 120_000)

    it('paints under the shipped policy without violating it or leaving the origin', async () => {
      const opened = await openRoute(SESSION_ROUTE, 'Terminal')
      // Chromium reports a refused subresource as a console error naming the directive, so
      // anything this closure loaded that the policy blocked lands here.
      expect(opened.errors.filter((entry) => entry.includes('Content Security Policy'))).toEqual([])
      // And nothing else at all, so this case reads the whole account and not only the policy.
      expect(opened.errors).toEqual([])
      // Stronger than the line above and independent of it: not one request left the origin, so
      // there is nothing for the policy to have refused. A font, a beacon or a provider image
      // added anywhere in this closure reds this.
      expect(opened.requestedHosts.filter((host) => host !== new URL(origin).host)).toEqual([])
      await opened.page.close()
    }, 120_000)

    it('asks the origin for no icon, which the shell has none to answer with', async () => {
      // The document declares `<link rel="icon" href="data:,">`. Without it a browser asks the
      // origin for /favicon.ico on its own, and the shell's asset server answers 403 because the
      // path is in no manifest — which the emulator run saw, repeatedly.
      //
      // Only a full Chrome asks; the bundled headless shell never does, so against the default
      // browser this case is a precondition rather than a measurement.
      // `ORCA_MOBILE_WEB_RENDER_BROWSER` is what CI resolves, and that is where this bites.
      // Read off the server's own log, not the page's: a favicon fetch is made by the browser
      // process rather than the page, and Playwright's `page.on('request')` never reports one.
      // The whole file's log, because no case here may produce this request.
      const opened = await openRoute(SESSION_ROUTE, 'Terminal')
      // Settled rather than read at the paint: a browser asks for the icon after `load`, later
      // than the text the route waited on, and reading there passes on a request still to come.
      await opened.page.waitForLoadState('networkidle')
      expect(servedPaths.filter((path) => path === '/favicon.ico')).toEqual([])
      // The precondition, so a run that recorded no request at all cannot pass this.
      expect(servedPaths).toContain('/')
      await opened.page.close()
    }, 120_000)

    it('paints with DOM storage off, which is how the Android shell serves it', async () => {
      // Every other case here runs against a real `localStorage`, which the page never has. The
      // one module that needed it was `expo-notifications`: `push-registration.ts` reached it and
      // its `DevicePushTokenAutoRegistration.fx` reads the persisted registration at import behind
      // a `typeof localStorage === 'undefined'` guard, which `null` walks straight through. That
      // put "Cannot read properties of null (reading 'getItem')" at error level on every page load
      // on the device. The page has no push registration; the shell owns it.
      const opened = await openRoute(SESSION_ROUTE, 'Terminal', {}, { domStorageOff: true })
      // Exact and not a filter, like the case above it: a module reaching browser storage the page
      // does not have is a defect wherever it comes from.
      expect(opened.errors).toEqual([])
      await opened.page.close()
    }, 120_000)

    it('writes no storage key it was never handed, on a mount that read the host status', async () => {
      // `status.get` is what arms it: `host-status-gates.ts` runs on every mount above the route,
      // and on a readable status the native `host-app-version-store.ts` writes
      // `orca:host-app-version:v1:<hostId>` — a key no page route reads and `page-storage-keys.ts`
      // does not admit, so the bridge refused it and logged one `storage-write-dropped` per mount
      // on the device. Answered here because the other cases' double answers no RPC at all, which
      // is exactly why this went unseen: the write needs a reply, not a control.
      const opened = await openRoute(SESSION_ROUTE, 'Terminal', {
        'status.get': {
          protocolVersion: 9,
          minCompatibleMobileVersion: 1,
          appVersion: '1.4.191',
          capabilities: []
        }
      })
      // The whole refusal and not this one key: any page-closure writer of an unlisted key lands
      // on the same line, and naming the key here would let the next one through.
      expect(opened.warnings.filter((text) => text.includes('storage-write-dropped'))).toEqual([])
      await opened.page.close()
    }, 120_000)

    it('asks the desktop for the session it was opened on, so the page above is live', async () => {
      // The precondition every assertion above needs: a screen that mounted and asked for nothing
      // would paint the same chrome. The three reads are the header's live title, the tab snapshot
      // and the terminal inventory, each carrying the workspace the route named.
      const opened = await openRoute(SESSION_ROUTE, 'Terminal')
      const requests = await opened.page.evaluate(() => globalThis.__orcaRenderCheckRequests ?? [])
      for (const method of ['worktree.show', 'session.tabs.list', 'terminal.list']) {
        expect(
          requests.some((request) => request.method === method),
          method
        ).toBe(true)
      }
      expect(JSON.stringify(requests)).toContain(WORKTREE)
      await opened.page.close()
    }, 120_000)
  },
  600_000
)

/**
 * What this file does not claim, and where each is answered instead.
 *
 * **The terminal.** No terminal is attached here, for the reason in the header: the screen paints
 * "Loading tabs" against a double that answers no RPC. `mobile-web-app-terminal-render.test.mjs`
 * is the browser proof of the terminal itself — xterm opening under `script-src 'self'`, an
 * escape-dense byte stream read back through the document's own selection path, zero CSP
 * violations — and it drives the same component through a probe route because a session screen
 * cannot reach one without the whole host protocol scripted.
 *
 * **The chat, the pickers and the clipboard.** Each is behind a control that only renders once the
 * screen has provider data, which is the same wall C4's render check names. They are pinned by the
 * source censuses beside them (`mobile-web-app-session-external-links.test.mjs`,
 * `mobile-web-app-session-media-picker.test.mjs`) and by the host and port-pair suites.
 *
 * **The browser pane.** `mobile-web-app-browser-pane-render.test.mjs` drives it with real frames;
 * what this route owes it is the `screencastBinary` grant, which
 * `mobile-web-app-screencast-lane-grant.test.mjs` derives from this closure.
 *
 * **The storage refusals a control makes.** The case above covers the writes a mount makes on its
 * own; a refusal a user's own write earns still needs the control. That chain is
 * `mobile/src/session/mobile-structured-send-page-storage-refusal.test.ts` end to end over the
 * real `page-async-storage`.
 */
