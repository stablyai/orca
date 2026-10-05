import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium } from 'playwright-core'
import { buildMobileWebAppBundle } from './build-mobile-web-app-bundle.mjs'
import { mobileWebAppDependenciesPresent } from './mobile-web-app-bundle-dependencies.mjs'
import {
  createBundleServer,
  installShellDouble,
  readBridgeFaultGrant,
  readBridgeProtocolVersion,
  readShellCsp
} from './mobile-web-app-render-harness.mjs'

/**
 * The tasks page route in a real browser: its own file, as C1.10 split the harness for.
 *
 * What only a browser answers for this route: that every module in its closure evaluates under
 * React Native Web, that the provider param the shell names reaches the screen, and that its chunk
 * arrives over the wire.
 *
 * It does not cover the three seams this series added. The closing note below says why, and where
 * each is proved instead.
 */

const HOST_ROUTE = '/h/render-check-host'
const TASKS_ROUTE = `${HOST_ROUTE}/tasks`
/** The patterns `init.pageRoutes` names, which is what the page matches a navigation against. */
const PAGE_ROUTE_PATTERNS = ['/h/[hostId]', '/h/[hostId]/tasks']
const SHELL_SESSION_ID = 'render-check-session'
const SHELL_BUILD_ID = 'render-check-build'
const SHELL_HOST = {
  id: 'render-check-host',
  name: 'Render Check Host',
  endpoint: 'ws://render-check',
  lastConnected: 1
}
const UNMATCHED = 'Unmatched Route'
const ROUTE_KEY = './h/[hostId]/tasks.tsx'
/** Exactly what the route declares in `MOBILE_WEB_PAGE_ROUTES`, plus the protocol's own grant. */
const TASKS_GRANTS = ['navigate', 'storage', 'externalLink', 'haptics', 'native.clipboard.write']

const bundles = mobileWebAppDependenciesPresent()
const describeRender = bundles ? describe : describe.skip

let scratch
let server
let browser
let origin
let routeChunks = {}
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
  scratch = await mkdtemp(join(tmpdir(), 'orca-mobile-web-app-tasks-'))
  const built = await buildMobileWebAppBundle({ outDir: join(scratch, 'bundle') })
  routeChunks = built.routeChunks
  const served = await createBundleServer({ outDir: built.outDir, cspHeader })
  server = served.server
  origin = served.origin
  const executablePath = process.env.ORCA_MOBILE_WEB_RENDER_BROWSER
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) })
}, 180_000)

afterAll(async () => {
  await browser?.close()
  server?.close()
  if (scratch) {
    await rm(scratch, { recursive: true, force: true })
  }
})

/** A page carrying every signal these cases read: uncaught errors, console errors, script paths. */
async function openPage({ shellRoute, shellGrants, shellPageRoutes = null } = {}) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
  // At document start, where the native shell installs the real channel: the entry reads it while
  // its own script runs, so a channel added after `load` would already be too late.
  await page.addInitScript(installShellDouble, {
    version: bridgeVersion,
    sessionId: SHELL_SESSION_ID,
    buildId: SHELL_BUILD_ID,
    route: shellRoute,
    host: SHELL_HOST,
    storage: {},
    faultGrant,
    // The harness falls back to the fault grant alone, which is the ungranted page.
    grants: shellGrants ?? [faultGrant],
    pageRoutes: shellPageRoutes
  })
  const errors = []
  const scripts = []
  let reportUncaught = () => {}
  const uncaught = new Promise((resolve) => {
    reportUncaught = resolve
  })
  page.on('pageerror', (error) => {
    errors.push(`${error.name}: ${error.message}`)
    reportUncaught(error)
  })
  page.on('console', (message) => {
    if (message.type() === 'error') {
      errors.push(`console.error: ${message.text()}`)
    }
  })
  page.on('response', (response) => {
    const path = new URL(response.url()).pathname
    if (response.status() === 200 && path.endsWith('.js')) {
      scripts.push(path)
    }
  })
  return { page, errors, scripts, uncaught }
}

/**
 * Wait for the entry to mount and then for the route's own content, polled rather than read once:
 * every screen is deferred behind `import()`, so `mounted` lands while the chunk is still arriving.
 */
async function waitForRoute({ page, errors, uncaught }, route, awaitText) {
  const named = (cause, what) =>
    new Error(`${route} ${what}: ${errors.join(' | ') || 'no page or console error'}`, { cause })
  const race = async (wait) =>
    Promise.race([
      wait.then(
        () => null,
        (error) => error
      ),
      uncaught
    ])
  const cause = await race(
    page.waitForFunction(() => document.documentElement.dataset.orcaWebEntry === 'mounted', {
      timeout: 30_000,
      polling: 250
    })
  )
  if (cause) {
    const state = await page.evaluate(
      () => document.documentElement.dataset.orcaWebEntry ?? 'absent'
    )
    throw named(cause, `never mounted (entry ${state})`)
  }
  const paintCause = await race(
    page.waitForFunction((needle) => document.body.innerText.includes(needle), awaitText, {
      timeout: 30_000,
      polling: 250
    })
  )
  if (paintCause) {
    throw named(paintCause, `mounted but never painted ${JSON.stringify(awaitText)}`)
  }
  for (const fault of await page.evaluate(() => globalThis.__orcaRenderCheckFaults ?? [])) {
    errors.push(`page fault: ${fault}`)
  }
}

/** Opens the document at `/`, the one path the shell serves, and lets the page route itself. */
async function openRoute(route, awaitText, options = {}) {
  const opened = await openPage({ shellRoute: { pathname: route }, ...options })
  await opened.page.goto(`${origin}/`, { waitUntil: 'load' })
  await waitForRoute(opened, route, awaitText)
  return opened
}

describeRender('the tasks route in a real browser', () => {
  /**
   * Every module in this route's closure imports and evaluates under React Native Web. How many
   * that is, and which, is pinned by `mobile-web-app-tasks-external-links.test.mjs`; repeating a
   * count here would be a second number to keep in step with the first.
   *
   * The unit tests cannot say this: they mock react-native, safe-area, svg, lucide and the icon
   * assets away, because react-native is Flow source vitest will not parse. Import-time breakage
   * in any of those modules has no other test.
   */
  it('mounts the tasks screen rather than the unmatched route', async () => {
    const opened = await openRoute(TASKS_ROUTE, 'Tasks', {
      shellGrants: [faultGrant, ...TASKS_GRANTS],
      shellPageRoutes: PAGE_ROUTE_PATTERNS
    })
    const text = await opened.page.evaluate(() => document.body.innerText)
    expect(text).toContain('Tasks')
    expect(text).not.toContain(UNMATCHED)
    expect(opened.errors).toEqual([])
    await opened.page.close()
  }, 60_000)

  it('carries the provider the shell named into the url the screen reads', async () => {
    // `taskSource` is the one page route with a query param, and it crosses in
    // `init.route.params`. Without this the param is only assumed to survive the handshake.
    const opened = await openPage({
      shellRoute: { pathname: TASKS_ROUTE, params: { taskSource: 'linear' } },
      shellGrants: [faultGrant, ...TASKS_GRANTS],
      shellPageRoutes: PAGE_ROUTE_PATTERNS
    })
    await opened.page.goto(`${origin}/`, { waitUntil: 'load' })
    await waitForRoute(opened, TASKS_ROUTE, 'Tasks')
    const url = await opened.page.evaluate(() => location.pathname + location.search)
    expect(url).toBe(`${TASKS_ROUTE}?taskSource=linear`)
    expect(opened.errors).toEqual([])
    await opened.page.close()
  }, 60_000)

  it("fetches this route's own chunk on a client-side navigation", async () => {
    const opened = await openRoute(HOST_ROUTE, SHELL_HOST.name, {
      shellGrants: [faultGrant, ...TASKS_GRANTS],
      shellPageRoutes: PAGE_ROUTE_PATTERNS
    })
    const loadedForFirstRoute = [...opened.scripts]
    await opened.page.evaluate((to) => {
      history.pushState(null, '', to)
      dispatchEvent(new PopStateEvent('popstate'))
    }, TASKS_ROUTE)
    await waitForRoute(opened, TASKS_ROUTE, 'Tasks')
    const chunk = routeChunks[ROUTE_KEY]
    expect(chunk, Object.keys(routeChunks).join(' ')).toBeTruthy()
    // Named by the builder rather than guessed from the bytes: this is what says the route came
    // over the wire now and not out of what the first route had already loaded.
    expect(opened.scripts.filter((path) => !loadedForFirstRoute.includes(path))).toContain(
      `/assets/${chunk}`
    )
    expect(loadedForFirstRoute).not.toContain(`/assets/${chunk}`)
    await opened.page.close()
  }, 60_000)
})

/**
 * What this file deliberately does not claim.
 *
 * The three seams this series added — the barrel's `Linking`, the router handoff and the clipboard
 * verb — are each reached from a control that only renders once the screen has provider data, and
 * the shell double answers no provider RPC. A case that posted those frames onto the channel
 * itself would prove the double and the transport, which the bridge suites already prove, and
 * would read as a tap that it never performed.
 *
 * Where each is proved instead: the barrel's export and the router's, by the source census in
 * `mobile/src/tasks/mobile-tasks-external-link.test.ts`; the closure having no react-native
 * `Linking` left in it, by `mobile-web-app-tasks-external-links.test.mjs`; the verb end to end,
 * by the host and port-pair suites. A tap-level proof needs provider replies lifted from the
 * recorded corpus, the way the agent-history check lifts its session list, and belongs with the
 * device proof rather than here.
 */
