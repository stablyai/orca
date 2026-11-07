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
const HOST_ROUTE_PATTERN = '/h/[hostId]'

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

// Open / as shell does, then route from init; direct route navigation would hide entry routing bugs.
async function render(route, awaitText, { shellRoute = { pathname: route }, ...shell } = {}) {
  const opened = await openPage({ shellRoute, ...shell })
  await opened.page.goto(`${origin}/`, { waitUntil: 'load' })
  await waitForRoute(opened, route, awaitText)
  const text = await opened.page.evaluate(() => document.body.innerText)
  // Read page’s session identity to catch mounting without shell’s session or inventing one.
  const session = await opened.page.evaluate(() => ({
    sessionId: document.documentElement.dataset.orcaWebSessionId ?? null,
    buildId: document.documentElement.dataset.orcaWebBuildId ?? null
  }))
  // Require rewrite from / before render or every host route resolves to Unmatched.
  const url = await opened.page.evaluate(() => location.pathname + location.search)
  await opened.page.close()
  // Name CSP refusals within asserted console errors for useful diagnostics.
  return {
    errors: opened.errors,
    cspErrors: opened.errors.filter((entry) => entry.includes('Content Security Policy')),
    text,
    session,
    url
  }
}

const paintReports = (page, name) =>
  page.evaluate(
    (paint) =>
      (globalThis.__orcaRenderCheckNotifies ?? []).filter((frame) => frame.name === paint).length,
    name
  )

describeRender('the Route A page in a real browser', () => {
  it('fills the view, so what it mounted is painted and takes a tap', async () => {
    const opened = await openPage({ shellRoute: { pathname: HOST_ROUTE } })
    await opened.page.goto(`${origin}/`, { waitUntil: 'load' })
    await waitForRoute(opened, HOST_ROUTE, SHELL_HOST.name)
    const layout = await opened.page.evaluate(() => {
      // No-RPC control at root bottom moves furthest if layout collapses.
      const fab = [...document.querySelectorAll('[role="button"]')].find(
        (element) => element.getAttribute('aria-label') === 'New workspace'
      )
      const box = fab?.getBoundingClientRect() ?? null
      const hit =
        box === null
          ? null
          : document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
      return {
        rootHeight: document.getElementById('root').getBoundingClientRect().height,
        viewportHeight: window.innerHeight,
        fabTop: box?.top ?? null,
        fabBottom: box?.bottom ?? null,
        reachesTheControl: hit !== null && fab.contains(hit)
      }
    })
    await opened.page.close()
    expect(opened.errors).toEqual([])
    // Measure height: mounted text/innerText can pass while collapsed root paints blank phone screen.
    expect(layout.rootHeight).toBe(layout.viewportHeight)
    expect(layout.fabTop).toBeGreaterThan(0)
    expect(layout.fabBottom).toBeLessThanOrEqual(layout.viewportHeight)
    // Require reachable tap: clipped scroller rows retain layout rects.
    expect(layout.reachesTheControl).toBe(true)
  }, 60_000)

  // Native files routes throw requireNativeViewManager at import; deferred import hides this until actual route opens, requiring web siblings.

  it('mounts the file preview, reading the file path out of a param and not a segment', async () => {
    const previewRoute = `${HOST_ROUTE}/files/preview/worktree-a`
    const { errors, cspErrors, text, url } = await render(previewRoute, 'readme.md', {
      shellRoute: {
        pathname: previewRoute,
        params: { relativePath: 'docs/my notes/readme.md', source: 'worktree' }
      }
    })
    expect(cspErrors).toEqual([])
    // Require no unsupported RN-Web BackHandler registration; Android hardware Back pops native stack while page Back owns unsaved-draft prompt.
    expect(errors).toEqual([])
    // Title proves final path segment only; URL checks outbound encoding, not middle-segment decoding.
    // Decode hazards are covered by mobile-file-path-route-encoding.test.ts and mobile-file-preview-route.test.ts.
    expect(text).toContain('readme.md')
    expect(url).toBe(`${previewRoute}?relativePath=docs%2Fmy+notes%2Freadme.md&source=worktree`)
    expect(text).not.toContain(UNMATCHED)
  }, 60_000)

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

  it('says nothing for a redirect screen whose target is still behind its chunk', async () => {
    // PR redirect remains mounted behind destination’s pending chunk; its own commit must not report screen paint.
    const target = routeChunks['./h/[hostId]/source-control/[worktreeId].tsx']
    expect(target, Object.keys(routeChunks).join(' ')).toBeTruthy()
    const path = `/assets/${target}`
    let arrive = () => {}
    heldChunks.set(
      path,
      new Promise((resolve) => {
        arrive = resolve
      })
    )
    try {
      const route = `${HOST_ROUTE}/pr/render-check-tree`
      const opened = await openPage({
        shellRoute: { pathname: route },
        shellPageRoutes: [HOST_ROUTE_PATTERN, '/h/[hostId]/pr/[worktreeId]']
      })
      await opened.page.goto(`${origin}/`, { waitUntil: 'load' })
      await opened.page.waitForFunction(
        () => location.pathname.includes('/source-control/'),
        undefined,
        { timeout: 30_000, polling: 250 }
      )
      // Router has moved but pending hub chunk still leaves document empty.
      await waitForPageFrames(opened.page)
      expect(await paintReports(opened.page, paintName)).toBe(0)

      arrive()
      await opened.page.waitForFunction(
        (name) =>
          (globalThis.__orcaRenderCheckNotifies ?? []).filter((frame) => frame.name === name)
            .length > 0,
        paintName,
        { timeout: 30_000, polling: 250 }
      )
      await opened.page.close()
    } finally {
      arrive()
      heldChunks.delete(path)
    }
  }, 120_000)

  it('refuses a target the shell will not take, rather than opening it in the page', async () => {
    // Fault-only grant makes notifyNavigate refuse like disposed/older shell; local fallback once mounted Unmatched or native-only session route.
    const opened = await openPage({ shellRoute: { pathname: HOST_ROUTE } })
    const { page, errors } = opened
    await page.goto(`${origin}/`, { waitUntil: 'load' })
    await waitForRoute(opened, HOST_ROUTE, SHELL_HOST.name)
    await page.getByLabel('Back to hosts').click()
    // Settle handoff microtask before asserting no navigation.
    await waitForPageFrames(page)
    expect(await page.evaluate(() => location.pathname)).toBe(HOST_ROUTE)
    const text = await page.evaluate(() => document.body.innerText)
    expect(text).toContain(SHELL_HOST.name)
    expect(text).not.toContain(UNMATCHED)
    // Require no notify as well as unchanged page; successful shell handoff also leaves document in place.
    const notifies = await page.evaluate(() => globalThis.__orcaRenderCheckNotifies ?? [])
    expect(notifies.filter((frame) => frame.name === 'navigate')).toEqual([])
    // Refused target declines navigation without faulting page.
    expect(await page.evaluate(() => globalThis.__orcaRenderCheckFaults ?? [])).toEqual([])
    expect(errors).toEqual([])
    await page.close()
  }, 60_000)

  it("fetches the next route's chunks on a client-side navigation", async () => {
    const opened = await openPage({ shellRoute: { pathname: HOST_ROUTE } })
    const { page, errors, scripts } = opened
    await page.goto(`${origin}/`, { waitUntil: 'load' })
    await waitForRoute(opened, HOST_ROUTE, SHELL_HOST.name)
    const loadedForFirstRoute = [...scripts]
    // Shell fetches document once; later route must arrive as a chunk through in-page history navigation.
    await page.evaluate((to) => {
      history.pushState(null, '', to)
      dispatchEvent(new PopStateEvent('popstate'))
    }, `${HOST_ROUTE}/tasks`)
    await waitForRoute(opened, `${HOST_ROUTE}/tasks`, 'Issues')
    expect(new URL(page.url()).pathname).toBe(`${HOST_ROUTE}/tasks`)
    const fetchedOnNavigation = scripts.filter((path) => !loadedForFirstRoute.includes(path))
    // Require builder-identified tasks chunk, not any fetched script or code already loaded by entry.
    const tasksChunk = routeChunks['./h/[hostId]/tasks.tsx']
    expect(tasksChunk, Object.keys(routeChunks).join(' ')).toBeTruthy()
    expect(fetchedOnNavigation, scripts.join(' ')).toContain(`/assets/${tasksChunk}`)
    expect(loadedForFirstRoute).not.toContain(`/assets/${tasksChunk}`)
    const text = await page.evaluate(() => document.body.innerText)
    expect(text).toContain('Tasks')
    expect(text).not.toContain(UNMATCHED)
    expect(errors).toEqual([])
    await page.close()
  }, 60_000)
})

// Probe mounted React Navigation canGoBack through real route chevron/router.back; page exposes no direct test hook.
// First prove same-family tap reaches shell, since an inert handler and refused local Back both leave document unchanged.
describeRender('the stack the page Back button rests on', () => {
  async function clickAndSettle(page, selector) {
    await page.click(selector)
    await waitForPageFrames(page)
    return page.evaluate(() => location.pathname + location.search)
  }

  it('carries a handoff the shell granted across the bridge from a real tap', async () => {
    // Grant navigate: this chevron proves handler/bridge path used by navigate-back before interpreting absent notifies.
    const opened = await openPage({
      shellRoute: { pathname: HOST_ROUTE },
      shellGrants: [faultGrant, 'navigate'],
      shellPageRoutes: [HOST_ROUTE_PATTERN]
    })
    await opened.page.goto(`${origin}/`, { waitUntil: 'load' })
    await waitForRoute(opened, HOST_ROUTE, SHELL_HOST.name)
    const url = await clickAndSettle(opened.page, '[aria-label="Back to hosts"]')
    await expect
      .poll(() =>
        opened.page.evaluate(() =>
          (globalThis.__orcaRenderCheckNotifies ?? []).filter((frame) => frame.name === 'navigate')
        )
      )
      .toEqual([{ v: bridgeVersion, type: 'notify', name: 'navigate', href: '/' }])
    // Require page stays on served route; local fallthrough would mount a screen document cannot serve.
    expect(url).toBe(HOST_ROUTE)
    expect(opened.errors).toEqual([])
    await opened.page.close()
  }, 60_000)
})
