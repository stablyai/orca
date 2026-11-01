import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium } from 'playwright-core'
import { buildMobileWebAppBundle } from '../build-mobile-web-app-bundle.mjs'
import { mobileWebAppDependenciesPresent } from './mobile-web-app-bundle-dependencies.mjs'
import {
  createBundleServer,
  installShellDouble,
  readBridgeFaultGrant,
  readBridgeProtocolVersion,
  readShellCsp
} from './preview/mobile-web-app-render-harness.mjs'

// Real browser verifies tasks closure evaluates, shell provider param reaches screen and route chunk fetches; provider-backed control seams are covered separately.

const HOST_ROUTE = '/h/render-check-host'
const TASKS_ROUTE = `${HOST_ROUTE}/tasks`
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

async function openPage({ shellRoute, shellGrants, shellPageRoutes = null } = {}) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
  // Install channel at document start like native shell; entry reads it before load.
  await page.addInitScript(installShellDouble, {
    version: bridgeVersion,
    sessionId: SHELL_SESSION_ID,
    buildId: SHELL_BUILD_ID,
    route: shellRoute,
    host: SHELL_HOST,
    storage: {},
    faultGrant,
    // Omitted grants fall back to fault-only ungranted page.
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

// Wait for route-specific content after mounted; deferred chunk can still be arriving.
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

// Open / as shell does, then let entry route from init.
async function openRoute(route, awaitText, options = {}) {
  const opened = await openPage({ shellRoute: { pathname: route }, ...options })
  await opened.page.goto(`${origin}/`, { waitUntil: 'load' })
  await waitForRoute(opened, route, awaitText)
  return opened
}

describeRender('the tasks route in a real browser', () => {
  // Unit tests mock Flow RN and native dependencies; only browser can catch real import/evaluation failures. Avoid duplicating source-census module counts.
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
    // taskSource query param must survive init.route.params handshake.
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
    // Builder-identified route chunk proves fresh fetch, not code already loaded by entry.
    expect(opened.scripts.filter((path) => !loadedForFirstRoute.includes(path))).toContain(
      `/assets/${chunk}`
    )
    expect(loadedForFirstRoute).not.toContain(`/assets/${chunk}`)
    await opened.page.close()
  }, 60_000)
})

// The shell has no provider replies, so this suite does not claim taps on provider-backed controls.
