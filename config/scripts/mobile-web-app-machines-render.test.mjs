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
 * The machines page route in a real browser, against a shell that answers machines.list and
 * machines.wake: the screen mounts under React Native Web, draws the desktop's providers, and a
 * Wake tap sends the machine's selector. ORCA_MOBILE_WEB_MACHINES_SCREENSHOT saves the page.
 */

const HOST_ROUTE = '/h/render-check-host'
const MACHINES_ROUTE = `${HOST_ROUTE}/machines`
const PAGE_ROUTE_PATTERNS = ['/h/[hostId]', '/h/[hostId]/machines']
const SHELL_SESSION_ID = 'render-check-session'
const SHELL_BUILD_ID = 'render-check-build'
const SHELL_HOST = {
  id: 'render-check-host',
  name: 'Render Check Host',
  endpoint: 'ws://render-check',
  lastConnected: 1
}
/** Exactly what the route declares in `MOBILE_WEB_PAGE_ROUTES`. */
const MACHINES_GRANTS = ['navigate', 'storage', 'externalLink', 'haptics']
const PROVIDER_KEY = 'plugin:orca-e2e.docker-machines/docker-machines'
const MACHINE = (overrides) => ({
  providerKey: PROVIDER_KEY,
  lifetime: 'persistent',
  createdAt: '2026-10-18T00:00:00Z',
  lastSeenAt: 1,
  ...overrides
})
const REPLIES = {
  'machines.list': {
    ok: true,
    value: [
      {
        providerKey: PROVIDER_KEY,
        name: 'Omarchy box',
        clockOffsetMs: 0,
        machines: [
          MACHINE({ id: 'sbx-1', name: 'omarchy-dev', state: 'running', detail: '4 vCPU · 8 GB' }),
          MACHINE({
            id: 'sbx-2',
            name: 'pr-2231',
            state: 'sleeping',
            lifetime: 'temporary',
            expiresAt: '2099-01-01T16:12:00Z'
          }),
          MACHINE({ id: 'sbx-3', name: 'old-review', state: 'gone' })
        ],
        pendingCreates: []
      }
    ]
  },
  'machines.wake': { ok: true, value: MACHINE({ id: 'sbx-2', name: 'pr-2231', state: 'running' }) }
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
  scratch = await mkdtemp(join(tmpdir(), 'orca-mobile-web-app-machines-'))
  const built = await buildMobileWebAppBundle({ outDir: join(scratch, 'bundle') })
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
async function openPage({ shellRoute, shellGrants, shellPageRoutes = null, replies } = {}) {
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
    pageRoutes: shellPageRoutes,
    replies
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

describeRender('the machines route in a real browser', () => {
  it("draws the desktop's machines and sends Wake for the tapped one", async () => {
    const opened = await openRoute(MACHINES_ROUTE, 'omarchy-dev', {
      shellGrants: [faultGrant, ...MACHINES_GRANTS],
      shellPageRoutes: PAGE_ROUTE_PATTERNS,
      replies: REPLIES
    })
    const text = await opened.page.evaluate(() => document.body.innerText)
    expect(text).toContain('Machines')
    expect(text).toContain('Omarchy box'.toUpperCase())
    expect(text).toContain('Running')
    expect(text).toContain('Sleeping')
    expect(text).toContain('Gone')
    expect(text).toContain('Create, archive and delete machines from the desktop.')
    if (process.env.ORCA_MOBILE_WEB_MACHINES_SCREENSHOT) {
      await opened.page.screenshot({ path: process.env.ORCA_MOBILE_WEB_MACHINES_SCREENSHOT })
    }
    await opened.page.getByRole('button', { name: 'Wake pr-2231' }).click()
    await opened.page.waitForFunction(() =>
      (globalThis.__orcaRenderCheckRequests ?? []).some(
        (request) => request.method === 'machines.wake'
      )
    )
    const wake = await opened.page.evaluate(() =>
      globalThis.__orcaRenderCheckRequests.find((request) => request.method === 'machines.wake')
    )
    expect(wake.params).toEqual({ providerKey: PROVIDER_KEY, machineId: 'sbx-2' })
    expect(opened.errors).toEqual([])
    await opened.page.close()
  }, 60_000)
})
