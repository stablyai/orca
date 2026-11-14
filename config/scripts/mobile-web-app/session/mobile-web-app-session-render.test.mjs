import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium } from 'playwright-core'
import { buildMobileWebAppBundle } from '../../build/mobile-web-app/build-mobile-web-app-bundle.mjs'
import { mobileWebAppDependenciesPresent } from '../mobile-web-app-bundle-dependencies.mjs'
import { MOBILE_WEB_PAGE_ROUTES } from '../../build/mobile-web-app/mobile-web-page-routes.mjs'
import {
  createBundleServer,
  installShellDouble,
  readBridgeFaultGrant,
  readBridgeProtocolVersion,
  readShellCsp,
  waitForRecordedRequests,
  waitForPageFrames
} from '../preview/mobile-web-app-render-harness.mjs'

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
  const served = await createBundleServer({ outDir: built.outDir, cspHeader })
  server = served.server
  origin = served.origin
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
  return { page, errors, warnings }
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

describeRender(
  'the session route in a real browser',
  () => {
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
  },
  600_000
)
