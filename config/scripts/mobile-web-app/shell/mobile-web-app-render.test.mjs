import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium } from 'playwright-core'
import { buildMobileWebAppBundle } from '../../build/mobile-web-app/build-mobile-web-app-bundle.mjs'
import { mobileWebAppDependenciesPresent } from '../mobile-web-app-bundle-dependencies.mjs'
import {
  createBundleServer,
  waitForPageFrames,
  installShellDouble,
  readBridgeFaultGrant,
  readBridgePagePainted,
  readBridgeProtocolVersion,
  readShellCsp
} from '../preview/mobile-web-app-render-harness.mjs'

// Mount real ExpoRoot: only rendering proves synthesized RequireContext has expected shape.
const HOST_ROUTE = '/h/render-check-host'

const SHELL_SESSION_ID = 'render-check-session'
const SHELL_BUILD_ID = 'render-check-build'
// Install init host: web expo-secure-store is empty, otherwise valid host paints Host not found.
const SHELL_HOST = {
  id: 'render-check-host',
  name: 'Render Check Host',
  endpoint: 'ws://render-check',
  lastConnected: 1
}

// Root shards lack mobile dependencies; browser bundling runs in mobile_web_app, while CSP tests run in both.
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

// Poison real route chunk to test boundary without substituting a synthetic route tree.
const poisonedChunks = new Set()
const POISON_MESSAGE = 'render check poisoned this route chunk'

// Hold chunks until released so pending-load assertions do not depend on winning a network race.
const heldChunks = new Map()
let paintName = null

beforeAll(async () => {
  cspHeader = await readShellCsp()
  bridgeVersion = await readBridgeProtocolVersion()
  faultGrant = await readBridgeFaultGrant()
  paintName = await readBridgePagePainted()
  if (!bundles) {
    return
  }
  scratch = await mkdtemp(join(tmpdir(), 'orca-mobile-web-app-render-'))
  const built = await buildMobileWebAppBundle({ outDir: join(scratch, 'bundle') })
  const { outDir } = built
  routeChunks = built.routeChunks
  // Prepend throw to retain exports/linking; replacing body would test link failure rather than evaluation failure.
  const served = await createBundleServer({
    outDir,
    cspHeader,
    transformChunk: (path, real) =>
      poisonedChunks.has(path)
        ? `throw new Error(${JSON.stringify(POISON_MESSAGE)});\n${real.toString('utf8')}`
        : real,
    handleRequest: (request, response, path) => {
      const held = heldChunks.get(path)
      if (!held) {
        return false
      }
      held
        .then(() => readFile(join(outDir, path.slice(1))))
        .then((real) => {
          response.writeHead(200, { 'content-type': 'text/javascript' })
          response.end(real)
        })
      return true
    }
  })
  server = served.server
  origin = served.origin
  // Use runner Chrome override to avoid CI browser downloads.
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

// Require route-specific content; Expo Unmatched also paints text without errors.
const UNMATCHED = 'Unmatched Route'

// Observe fetched scripts as proof navigation loads next chunk; undefined shellRoute omits double, null installs shell without screen.
async function openPage({
  shellRoute,
  shellHost = SHELL_HOST,
  shellStorage = {},
  shellGrants,
  shellPageRoutes = null
} = {}) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
  if (shellRoute !== undefined) {
    // Install channel at document start like native shell; entry reads it before load.
    await page.addInitScript(installShellDouble, {
      version: bridgeVersion,
      sessionId: SHELL_SESSION_ID,
      buildId: SHELL_BUILD_ID,
      route: shellRoute,
      host: shellHost,
      storage: shellStorage,
      faultGrant,
      grants: shellGrants ?? [faultGrant],
      pageRoutes: shellPageRoutes
    })
  }
  const errors = []
  const scripts = []
  let reportUncaught = () => {}
  // Race mount wait with entry errors to report native-only import failures without 30s timeout.
  // Resolve rather than reject: error can settle during goto before any waiter attaches.
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

// Wait for route-specific content after mounted: deferred route chunk can still leave suspense body empty.
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
  // Require committed Expo tree signal; root children can be an error/fallback. Timer polling works even when page never paints rAF.
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
  // Fold boundary faults into asserted errors: caught throws emit no pageerror and may leave blank body.
  for (const fault of await page.evaluate(() => globalThis.__orcaRenderCheckFaults ?? [])) {
    errors.push(`page fault: ${fault}`)
  }
}

const paintReports = (page, name) =>
  page.evaluate(
    (paint) =>
      (globalThis.__orcaRenderCheckNotifies ?? []).filter((frame) => frame.name === paint).length,
    name
  )

describeRender('the Route A page in a real browser', () => {
  it('tells the shell when a route chunk throws, rather than sitting on a blank page', async () => {
    const chunk = routeChunks['./h/[hostId]/index.tsx']
    expect(chunk, Object.keys(routeChunks).join(' ')).toBeTruthy()
    poisonedChunks.add(`/assets/${chunk}`)
    try {
      const opened = await openPage({ shellRoute: { pathname: HOST_ROUTE } })
      await opened.page.goto(`${origin}/`, { waitUntil: 'load' })
      const reported = await opened.page
        .waitForFunction(
          () => {
            const faults = globalThis.__orcaRenderCheckFaults ?? []
            return faults.length > 0 ? faults : null
          },
          { timeout: 30_000, polling: 250 }
        )
        .then((handle) => handle.jsonValue())
      // Require poisoned module’s exact error; any-fault check could pass with wrong boundary report.
      expect(reported.join(' | ')).toContain(POISON_MESSAGE)
      // Router shell commits mounted before deferred rejection; require boundary removes screen beneath it.
      const text = await opened.page.evaluate(() => document.body.innerText)
      expect(text).not.toContain('Host not found')
      expect(text).not.toContain(UNMATCHED)
      await opened.page.close()
    } finally {
      poisonedChunks.delete(`/assets/${chunk}`)
    }
  }, 60_000)

  it('reports its frame from the route screen, not from the router shell above it', async () => {
    // A paint reported before the route chunk arrives would uncover an empty body.
    const chunk = routeChunks['./h/[hostId]/index.tsx']
    expect(chunk, Object.keys(routeChunks).join(' ')).toBeTruthy()
    const path = `/assets/${chunk}`
    let arrive = () => {}
    heldChunks.set(
      path,
      new Promise((resolve) => {
        arrive = resolve
      })
    )
    try {
      const opened = await openPage({ shellRoute: { pathname: HOST_ROUTE } })
      await opened.page.goto(`${origin}/`, { waitUntil: 'load' })
      await opened.page.waitForFunction(
        () => document.documentElement.dataset.orcaWebEntry === 'shell-ready',
        { timeout: 30_000, polling: 250 }
      )
      await waitForPageFrames(opened.page)
      // The page waits for its route's held chunk before it mounts, so nothing may mount or report a paint meanwhile.
      expect(await opened.page.evaluate(() => document.documentElement.dataset.orcaWebEntry)).toBe(
        'shell-ready'
      )
      expect(await paintReports(opened.page, paintName)).toBe(0)

      arrive()
      await waitForRoute(opened, HOST_ROUTE, SHELL_HOST.name)
      await opened.page.waitForFunction(
        (name) =>
          (globalThis.__orcaRenderCheckNotifies ?? []).filter((frame) => frame.name === name)
            .length > 0,
        paintName,
        { timeout: 30_000, polling: 250 }
      )
      expect(opened.errors).toEqual([])
      await opened.page.close()
    } finally {
      arrive()
      heldChunks.delete(path)
    }
  }, 120_000)
})
