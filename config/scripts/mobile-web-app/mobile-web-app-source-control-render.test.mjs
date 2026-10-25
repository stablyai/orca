import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
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

// Render real source-control/review routes under shipped CSP to prove RN-Web evaluation, own-screen paint and client-side chunk fetch.
// No comment card renders without PR RPC chain: this suite cannot prove avatar skip; pr-comment-card-web-avatar.test.tsx covers that branch.
// Off-origin/policy assertions cover only content actually painted here.

const projectDir = fileURLToPath(new URL('../../..', import.meta.url))
const HOST_ROUTE = '/h/render-check-host'
const WORKTREE = 'wt-1'
const HUB_ROUTE = `${HOST_ROUTE}/source-control/${WORKTREE}`
const REVIEW_ROUTE = `${HOST_ROUTE}/review/${WORKTREE}`
const PAGE_ROUTE_PATTERNS = [HOST_ROUTE.replace('render-check-host', '[hostId]')].concat(
  '/h/[hostId]/source-control/[worktreeId]',
  '/h/[hostId]/review/[worktreeId]'
)
const SHELL_SESSION_ID = 'render-check-session'
const SHELL_BUILD_ID = 'render-check-build'
const SHELL_HOST = {
  id: 'render-check-host',
  name: 'Render Check Host',
  endpoint: 'ws://render-check',
  lastConnected: 1
}
const UNMATCHED = 'Unmatched Route'
const HUB_CHUNK_KEY = './h/[hostId]/source-control/[worktreeId].tsx'
const REVIEW_CHUNK_KEY = './h/[hostId]/review/[worktreeId].tsx'
const C4_GRANTS = ['navigate', 'storage', 'externalLink', 'haptics', 'native.clipboard.write']

// Answer only GitHub remote to expose PR triggers; scripting downstream domain RPC chain would make transport double decide behavior.
const REPLIES = { 'github.repoSlug': { owner: 'orca', repo: 'orca' } }

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
  scratch = await mkdtemp(join(tmpdir(), 'orca-mobile-web-app-source-control-'))
  const built = await buildMobileWebAppBundle({ outDir: join(scratch, 'bundle') })
  routeChunks = built.routeChunks
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

async function openPage(route) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
  // Install channel at document start like native shell; entry reads it before load.
  await page.addInitScript(installShellDouble, {
    version: bridgeVersion,
    sessionId: SHELL_SESSION_ID,
    buildId: SHELL_BUILD_ID,
    route: { pathname: route },
    host: SHELL_HOST,
    storage: {},
    faultGrant,
    grants: [faultGrant, ...C4_GRANTS],
    pageRoutes: PAGE_ROUTE_PATTERNS,
    replies: REPLIES
  })
  const errors = []
  const scripts = []
  const requestedHosts = []
  page.on('pageerror', (error) => errors.push(`${error.name}: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error') {
      errors.push(`console.error: ${message.text()}`)
    }
  })
  // Observe attempted requests too: CSP-blocked fetches lack responses.
  page.on('request', (request) => requestedHosts.push(new URL(request.url()).host))
  page.on('response', (response) => {
    const path = new URL(response.url()).pathname
    if (response.status() === 200 && path.endsWith('.js')) {
      scripts.push(path)
    }
  })
  return { page, errors, scripts, requestedHosts }
}

// Wait for route-specific content after mounted; deferred screen chunk may still be arriving.
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
  // Report boundary-caught route error directly instead of mount timeout.
  for (const fault of await page.evaluate(() => globalThis.__orcaRenderCheckFaults ?? [])) {
    errors.push(`page fault: ${fault}`)
  }
}

async function openRoute(route, awaitText) {
  const opened = await openPage(route)
  await opened.page.goto(`${origin}/`, { waitUntil: 'load' })
  await waitForRoute(opened, route, awaitText)
  return opened
}

describeRender(
  'the source-control and review routes in a real browser',
  () => {
    it('mounts the source-control hub rather than the unmatched route', async () => {
      const opened = await openRoute(HUB_ROUTE, 'Source Control')
      const text = await opened.page.evaluate(() => document.body.innerText)
      // Require hub segment chips, beyond generic header text.
      for (const chip of ['Changes', 'Pull Request', 'Commits']) {
        expect(text).toContain(chip)
      }
      expect(text).not.toContain(UNMATCHED)
      expect(opened.errors).toEqual([])
      expect(opened.requestedHosts.filter((host) => host !== new URL(origin).host)).toEqual([])
      await opened.page.close()
    }, 120_000)

    it('mounts diff review rather than the unmatched route', async () => {
      const opened = await openRoute(REVIEW_ROUTE, 'reviewed')
      const text = await opened.page.evaluate(() => document.body.innerText)
      // Queue filters distinguish review screen from generic header.
      for (const filter of ['All', 'Unreviewed', 'Notes']) {
        expect(text).toContain(filter)
      }
      expect(text).not.toContain(UNMATCHED)
      expect(opened.errors).toEqual([])
      expect(opened.requestedHosts.filter((host) => host !== new URL(origin).host)).toEqual([])
      await opened.page.close()
    }, 120_000)

    it.each([
      ['source-control', HUB_ROUTE, 'Source Control', HUB_CHUNK_KEY],
      ['review', REVIEW_ROUTE, 'reviewed', REVIEW_CHUNK_KEY]
    ])(
      "fetches %s's own chunk on a client-side navigation",
      async (_name, route, text, key) => {
        const opened = await openRoute(HOST_ROUTE, SHELL_HOST.name)
        const loadedForFirstRoute = [...opened.scripts]
        await opened.page.evaluate((to) => {
          history.pushState(null, '', to)
          dispatchEvent(new PopStateEvent('popstate'))
        }, route)
        await waitForRoute(opened, route, text)
        const chunk = routeChunks[key]
        expect(chunk, Object.keys(routeChunks).join(' ')).toBeTruthy()
        // Builder-identified route chunk proves fresh fetch rather than code already loaded by entry.
        expect(opened.scripts.filter((path) => !loadedForFirstRoute.includes(path))).toContain(
          `/assets/${chunk}`
        )
        expect(loadedForFirstRoute).not.toContain(`/assets/${chunk}`)
        await opened.page.close()
      },
      120_000
    )

    it('configures the shipped Android and iOS image policy', async () => {
      // Read shipped Kotlin CSP instead of duplicating a header fixture.
      expect(cspHeader).toContain("img-src 'self' data: blob: https:")
      const swift = await readFile(
        join(projectDir, 'mobile/modules/orca-mobile-web-shell/ios/MobileWebShellCsp.swift'),
        'utf8'
      )
      // Check iOS source too; served Android header cannot prove other shell agrees.
      expect(swift).toContain(`"img-src 'self' data: blob: https:"`)
    }, 180_000)
  },
  600_000
)

// PR cards/drawer need unscripted github.prForBranch/prComments and worktree/repo RPC chain; avatar branch uses component test, drawer scrolling device proof.
// Data-gated link/clipboard/router controls use sibling source censuses and host/port-pair suites.
