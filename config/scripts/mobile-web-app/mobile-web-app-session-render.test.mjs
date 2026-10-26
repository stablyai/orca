import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium } from 'playwright-core'
import { buildMobileWebAppBundle } from '../build-mobile-web-app-bundle.mjs'
import { mobileWebAppDependenciesPresent } from './mobile-web-app-bundle-dependencies.mjs'
import { MOBILE_WEB_PAGE_ROUTES } from '../mobile-web-page-routes.mjs'
import {
  createBundleServer,
  installShellDouble,
  readBridgeFaultGrant,
  readBridgeProtocolVersion,
  readShellCsp,
  waitForRecordedRequests,
  waitForPageFrames
} from './preview/mobile-web-app-render-harness.mjs'

// Render real session closure under shipped CSP; unit tests mock RN and cannot prove browser import/evaluation, route paint or deferred fetch.
// Assert every console error: unguarded RN-Web BackHandler and rejected diff-note loads once logged silently on mount.
// No terminal attaches against no-RPC double; terminal-render proves terminal content/CSP, session-terminal-init proves session attachment.

const HOST_ROUTE = '/h/render-check-host'
const WORKTREE = 'wt-1'
const SESSION_ROUTE = `${HOST_ROUTE}/session/${WORKTREE}`
const SESSION_PATTERN = '/h/[hostId]/session/[worktreeId]'
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

// Read grants from manifest so new route grants are exercised instead of silently omitted by copied fixture.
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

async function openPage(route, replies = {}, { domStorageOff = false } = {}) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
  if (domStorageOff) {
    // Match Android WebView storage-off behavior: localStorage is null, not undefined; import-time push storage reads once threw getItem here.
    await page.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', { configurable: true, get: () => null })
    })
  }
  // Install channel at document start like native shell; entry reads it before load.
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
    // Track warnings separately: storage-write-dropped would evade error-only assertions.
    if (message.type() === 'warning') {
      warnings.push(message.text())
    }
  })
  // Observe requests, not just responses; CSP-blocked fetches must still count as attempts.
  page.on('request', (request) => requestedHosts.push(new URL(request.url()).host))
  page.on('response', (response) => {
    const path = new URL(response.url()).pathname
    if (response.status() === 200 && path.endsWith('.js')) {
      scripts.push(path)
    }
  })
  return { page, errors, warnings, scripts, requestedHosts }
}

// Wait for route content after mounted: deferred screen chunk may still be arriving.
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
  // Report boundary-caught route fault directly instead of timing out on mount.
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

const BACK_LABEL = 'Back to worktrees'

const SESSION_MOUNT_READS = ['worktree.show', 'session.tabs.list', 'terminal.list']

describeRender(
  'the session route in a real browser',
  () => {
    it('mounts the session screen rather than the unmatched route, with nothing on the console', async () => {
      const opened = await openRoute(SESSION_ROUTE, 'Terminal')
      const text = await opened.page.evaluate(() => document.body.innerText)
      // Accessory-bar keys prove session screen, beyond generic header text.
      for (const key of ['Esc', 'Tab', 'Ctrl+C', 'Ctrl+R']) {
        expect(text).toContain(key)
      }
      expect(text).not.toContain(UNMATCHED)
      // Require exact empty list: BackHandler and uncaught diff-note defects were console-only.
      expect(opened.errors).toEqual([])
      expect(opened.requestedHosts.filter((host) => host !== new URL(origin).host)).toEqual([])
      await opened.page.close()
    }, 120_000)

    it('puts the Back control in the accessibility tree by name', async () => {
      const opened = await openRoute(SESSION_ROUTE, 'Terminal')
      const control = await opened.page.evaluate((label) => {
        const found = document.querySelector(`[aria-label="${label}"]`)
        return found === null ? null : { role: found.getAttribute('role'), tag: found.tagName }
      }, BACK_LABEL)
      // Require actual button role: RN-Web div can carry label without exposing accessible action.
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
      // Identify route chunk through builder to prove fresh fetch, not code already loaded by entry.
      expect(opened.scripts.filter((path) => !loadedForFirstRoute.includes(path))).toContain(
        `/assets/${chunk}`
      )
      expect(loadedForFirstRoute).not.toContain(`/assets/${chunk}`)
      await opened.page.close()
    }, 120_000)

    it('asks the origin for no icon, which the shell has none to answer with', async () => {
      // data:, icon prevents /favicon.ico fetch forbidden by shell manifest. Only full Chrome requests it; headless shell coverage is a precondition.
      // Read whole suite’s server log: browser-process favicon requests never reach page.on(request).
      const opened = await openRoute(SESSION_ROUTE, 'Terminal')
      // Wait past load: favicon request may arrive after route text paints.
      await opened.page.waitForLoadState('networkidle')
      expect(servedPaths.filter((path) => path === '/favicon.ico')).toEqual([])
      // Require recorded requests so empty log cannot prove no favicon fetch.
      expect(servedPaths).toContain('/')
      await opened.page.close()
    }, 120_000)

    it('paints with DOM storage off, which is how the Android shell serves it', async () => {
      // Null-storage arm reproduces Android import-time expo-notifications failure; shell owns push and pages must not load it.
      const opened = await openRoute(SESSION_ROUTE, 'Terminal', {}, { domStorageOff: true })
      // Require all errors absent; filtering known push failure could hide other illegal storage users.
      expect(opened.errors).toEqual([])
      await opened.page.close()
    }, 120_000)

    it('writes no storage key it was never handed, on a mount that read the host status', async () => {
      // Answer status.get: host-status-gates once wrote unlisted orca:host-app-version key only after readable reply, invisible to no-RPC cases.
      const opened = await openRoute(SESSION_ROUTE, 'Terminal', {
        'status.get': {
          protocolVersion: 9,
          minCompatibleMobileVersion: 1,
          appVersion: '1.4.191',
          capabilities: []
        }
      })
      await waitForRecordedRequests(opened.page, ['status.get'])
      await waitForPageFrames(opened.page)
      // Reject every dropped storage write, not just known key, to catch future unlisted writers.
      expect(opened.warnings.filter((text) => text.includes('storage-write-dropped'))).toEqual([])
      await opened.page.close()
    }, 120_000)

    it('asks the desktop for the session it was opened on, so the page above is live', async () => {
      // Require title/tab/inventory RPCs with correct workspace or same chrome could pass without host reads.
      // Await effects after paint: under 20× CPU throttle none had fired at initial Terminal commit.
      const opened = await openRoute(SESSION_ROUTE, 'Terminal')
      const requests = await waitForRecordedRequests(opened.page, SESSION_MOUNT_READS)
      for (const method of SESSION_MOUNT_READS) {
        const observed = requests.filter((request) => request.method === method)
        expect(observed.length, method).toBeGreaterThan(0)
        for (const request of observed) {
          expect(request.params.worktree, method).toBe(`id:${WORKTREE}`)
        }
      }
      await opened.page.close()
    }, 120_000)
  },
  600_000
)

// Coverage boundaries: terminal-render proves xterm/CSP/transcript; session-terminal-init proves attachment.
// Data-gated chat/picker/clipboard controls use sibling source censuses and host/port-pair suites.
// browser-pane-render proves frame paint; screencast-lane-grant derives route grant; page-async-storage tests store write refusals.
