import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium } from 'playwright-core'
import { buildMobileWebAppBundle } from '../build-mobile-web-app-bundle.mjs'
import { mobileWebAppDependenciesPresent } from './mobile-web-app-bundle-dependencies.mjs'
import {
  createBundleServer,
  waitForPageFrames,
  installShellDouble,
  parseCspDirectives,
  projectDir,
  readBridgeFaultGrant,
  readBridgePagePainted,
  readBridgeProtocolVersion,
  readShellCsp
} from './preview/mobile-web-app-render-harness.mjs'

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

async function renderWithoutTree({ shellRoute } = {}) {
  const { page, errors } = await openPage({ shellRoute })
  // Read immediately after load: entry decides synchronously, so further polling would hide an unsettled decision.
  await page.goto(`${origin}/`, { waitUntil: 'load' })
  const entry = await page.evaluate(() => document.documentElement.dataset.orcaWebEntry ?? 'absent')
  const rootChildren = await page.evaluate(() => document.getElementById('root').childElementCount)
  const text = await page.evaluate(() => document.body.innerText)
  const url = await page.evaluate(() => location.pathname + location.search)
  await page.close()
  return { entry, errors, rootChildren, text, url }
}

describe('the shell policy this page is tested under', () => {
  it('is the same on both platforms, so one render check covers both', async () => {
    const swift = await readFile(
      join(projectDir, 'mobile/modules/orca-mobile-web-shell/ios/MobileWebShellCsp.swift'),
      'utf8'
    )
    expect(parseCspDirectives(swift, 'static let header = [', '].joined')).toBe(cspHeader)
  })

  it('reads directives from the source and not from the comments around them', () => {
    const source = [
      'static let header = [',
      "  // React Native Web needs \"style-src 'self' 'unsafe-inline'\" and nothing more.",
      '  "default-src \'none\'",',
      '  "script-src \'self\'",',
      "  \"style-src 'self' 'unsafe-inline'\",",
      '  "img-src \'self\'",',
      '  "connect-src \'self\'",',
      '  "worker-src \'none\'",',
      '  "frame-src \'none\'",',
      '  "child-src \'none\'",',
      '  "object-src \'none\'",',
      '  "base-uri \'none\'",',
      '  "form-action \'none\'",',
      '  "frame-ancestors \'none\'"',
      '].joined'
    ].join('\n')
    const parsed = parseCspDirectives(source, 'static let header = [', '].joined')
    expect(parsed.split('; ')[0]).toBe("default-src 'none'")
    expect(parsed.split('; ').filter((entry) => entry.includes('unsafe-inline'))).toEqual([
      "style-src 'self' 'unsafe-inline'"
    ])
  })

  it('admits only cached Blob URLs for media', () => {
    expect(cspHeader.split('; ').filter((entry) => entry.startsWith('media-src'))).toEqual([
      'media-src blob:'
    ])
  })

  it('still refuses inline script, which is the directive that matters', () => {
    expect(cspHeader).toContain("script-src 'self';")
    expect(cspHeader).not.toContain("script-src 'self' 'unsafe-inline'")
  })

  it('admits embedded fonts and limits external sources to images', () => {
    expect(cspHeader.split('; ').filter((entry) => entry.includes('data:'))).toEqual([
      "img-src 'self' data: blob: https:",
      "font-src 'self' data:"
    ])
    expect(cspHeader.split('; ').filter((entry) => entry.includes('https:'))).toEqual([
      "img-src 'self' data: blob: https:"
    ])
    expect(cspHeader).not.toContain('http:')
  })
})

// 1×1 PNG proves decoding, not merely policy admission.
const DATA_URI_IMAGE =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

describeRender('an image preview under the shell policy', () => {
  it('decodes a data: URI, which is the only shape a file preview has', async () => {
    // Match RN-Web ImageLoader’s new Image/onload path for data:<mime>;base64 preview URLs.
    // Component’s hidden img lacks load/error handlers and serves context menu/getBackgroundSize, so it cannot prove preview load succeeds.
    const { page, errors } = await openPage()
    await page.goto(`${origin}/`, { waitUntil: 'load' })
    const naturalWidth = await page.evaluate(
      (uri) =>
        new Promise((resolve) => {
          const image = new Image()
          image.addEventListener('load', () => resolve(image.naturalWidth))
          image.addEventListener('error', () => resolve(0))
          image.src = uri
        }),
      DATA_URI_IMAGE
    )
    await page.close()
    expect({
      naturalWidth,
      refused: errors.filter((entry) => entry.includes('Content Security Policy'))
    }).toEqual({ naturalWidth: 1, refused: [] })
  })
})

describeRender('the page server this check runs against', () => {
  it('404s a file path the bundle does not contain', async () => {
    // Restrict served prefix or catch-all server would hide unusable script publicPath.
    expect((await fetch(`${origin}/wrong-prefix/entry.js`)).status).toBe(404)
    expect((await fetch(`${origin}/assets/not-a-real-hash.js`)).status).toBe(404)
  })

  it('answers the icon a browser asks for without an error', async () => {
    expect((await fetch(`${origin}/favicon.ico`)).status).toBe(204)
  })

  it('still serves the document at every route depth', async () => {
    for (const route of ['/', HOST_ROUTE, `${HOST_ROUTE}/tasks`]) {
      const response = await fetch(`${origin}${route}`)
      expect(response.status, route).toBe(200)
      expect(await response.text(), route).toContain('<div id="root">')
    }
  })
})

describeRender('the Route A page in a real browser', () => {
  it('mounts the worktree list route, not the unmatched screen', async () => {
    const { errors, cspErrors, text, session, url } = await render(HOST_ROUTE, SHELL_HOST.name)
    expect(cspErrors).toEqual([])
    expect(errors).toEqual([])
    expect(session).toEqual({ sessionId: SHELL_SESSION_ID, buildId: SHELL_BUILD_ID })
    expect(url).toBe(HOST_ROUTE)
    expect(text).toContain(SHELL_HOST.name)
    expect(text).not.toContain('Host not found')
    expect(text).not.toContain(UNMATCHED)
  }, 60_000)

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

  it('routes a nested dynamic segment through the same context', async () => {
    const { errors, cspErrors, text, session } = await render(`${HOST_ROUTE}/tasks`, 'Tasks')
    expect(cspErrors).toEqual([])
    expect(errors).toEqual([])
    expect(session.sessionId).toBe(SHELL_SESSION_ID)
    expect(text).toContain('Tasks')
    expect(text).toContain('Issues')
    expect(text).not.toContain(UNMATCHED)
  }, 60_000)

  // Native files routes throw requireNativeViewManager at import; deferred import hides this until actual route opens, requiring web siblings.
  it('mounts the file explorer, which its native route module cannot do', async () => {
    const worktreeRoute = `${HOST_ROUTE}/files/worktree-a`
    const { errors, cspErrors, text } = await render(worktreeRoute, 'Files', {
      shellRoute: { pathname: worktreeRoute, params: { name: 'Example Worktree' } }
    })
    expect(cspErrors).toEqual([])
    expect(errors).toEqual([])
    expect(text).toContain('Files')
    expect(text).toContain('Example Worktree')
    expect(text).not.toContain(UNMATCHED)
  }, 60_000)

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

  it('refuses a host-scoped path with no module rather than crashing', async () => {
    // Catch-all host route must paint refusal and avoid Unmatched; both assertions distinguish refusal from blank screen.
    const refusal = 'This workspace screen is not available on this host.'
    const { errors, cspErrors, text } = await render(`${HOST_ROUTE}/not-a-route`, refusal)
    expect(cspErrors).toEqual([])
    expect(errors).toEqual([])
    expect(text).toContain(refusal)
    expect(text).not.toContain(UNMATCHED)
  }, 60_000)

  it('carries the params the shell named into the url the screen reads', async () => {
    const { errors, url } = await render(HOST_ROUTE, SHELL_HOST.name, {
      shellRoute: { pathname: HOST_ROUTE, params: { from: 'render check' } }
    })
    expect(errors).toEqual([])
    expect(url).toBe(`${HOST_ROUTE}?from=render+check`)
  }, 60_000)

  it('paints the not-found state when the shell named no host, which is what makes the row real', async () => {
    const { errors, text } = await render(HOST_ROUTE, 'Host not found', { shellHost: null })
    expect(errors).toEqual([])
    expect(text).toContain('Host not found')
    expect(text).not.toContain(SHELL_HOST.name)
  }, 60_000)

  it('mounts nothing at all when no shell answered, which is what makes the rest real', async () => {
    // Control catches pages ignoring init entirely.
    const { entry, errors, rootChildren } = await renderWithoutTree()
    expect(entry).toBe('unbridged')
    expect(rootChildren).toBe(0)
    expect(errors).toEqual([])
  }, 60_000)

  it('says to update the app when the shell that opened it named no screen', async () => {
    const { entry, errors, text, url } = await renderWithoutTree({ shellRoute: null })
    expect(entry).toBe('shell-too-old')
    expect(errors).toEqual([])
    expect(text).toContain('Update Orca to open this workspace')
    // Missing route must not mount Unmatched tree at /.
    expect(text).not.toContain(UNMATCHED)
    expect(url).toBe('/')
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
    // Suspense wrapper commits before route chunk arrives; reporting paint there would uncover empty body.
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
        () => document.documentElement.dataset.orcaWebEntry === 'mounted',
        { timeout: 30_000, polling: 250 }
      )
      // Mounted with empty fallback body reproduces premature paint signal.
      expect(await opened.page.evaluate(() => document.body.innerText)).not.toContain(
        SHELL_HOST.name
      )
      await waitForPageFrames(opened.page)
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
  const EDIT_ROUTE = `${HOST_ROUTE}/edit`
  const BACK_ON_EDIT = '[aria-label="Back"]'

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

  it('cannot go back on the document the shell just opened, which is the one screen it has', async () => {
    const opened = await openPage({ shellRoute: { pathname: EDIT_ROUTE } })
    await opened.page.goto(`${origin}/`, { waitUntil: 'load' })
    await waitForRoute(opened, EDIT_ROUTE, 'Edit host')
    expect(await opened.page.locator(BACK_ON_EDIT).count()).toBe(1)
    expect(await clickAndSettle(opened.page, BACK_ON_EDIT)).toBe(EDIT_ROUTE)
    expect(opened.errors).toEqual([])
    await opened.page.close()
  }, 60_000)

  it('is given no stack by a location change either, only by a push this page makes itself', async () => {
    // Entry replaceState and external location changes reset router instead of stacking it; extra browser history cannot make canGoBack true.
    // Local Back branch requires an in-page useRouteHandoff push, which this tree currently has none of.
    const opened = await openPage({ shellRoute: { pathname: HOST_ROUTE } })
    await opened.page.goto(`${origin}/`, { waitUntil: 'load' })
    await waitForRoute(opened, HOST_ROUTE, SHELL_HOST.name)
    const entriesBefore = await opened.page.evaluate(() => history.length)
    await opened.page.evaluate((to) => {
      history.pushState(null, '', to)
      dispatchEvent(new PopStateEvent('popstate'))
    }, EDIT_ROUTE)
    await waitForRoute(opened, EDIT_ROUTE, 'Edit host')
    expect(await opened.page.evaluate(() => history.length)).toBe(entriesBefore + 1)
    expect(await clickAndSettle(opened.page, BACK_ON_EDIT)).toBe(EDIT_ROUTE)
    // Synthetic popstate faults could leave page unchanged; require no boundary fault to validate absence.
    expect(opened.errors).toEqual([])
    await opened.page.close()
  }, 60_000)
})
