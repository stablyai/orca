import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium } from 'playwright-core'
import { buildMobileWebAppBundle } from './build-mobile-web-app-bundle.mjs'
import { mobileWebAppDependenciesPresent } from './mobile-web-app-bundle-dependencies.mjs'
import {
  createBundleServer,
  installShellDouble,
  parseCspDirectives,
  projectDir,
  readBridgeFaultGrant,
  readBridgeProtocolVersion,
  readShellCsp
} from './mobile-web-app-render-harness.mjs'

// Why a real browser: the route tree is handed to expo-router's own ExpoRoot through a synthesized
// RequireContext. Nothing short of mounting it proves that object is the shape ExpoRoot reads.
const HOST_ROUTE = '/h/render-check-host'

// What the double answers `ready` with. Asserted on the document, so a page that mounted against
// some other session, or against none, fails here rather than on a phone.
const SHELL_SESSION_ID = 'render-check-session'
const SHELL_BUILD_ID = 'render-check-build'
// The host the shell opened the page for. Without it `expo-secure-store` is {} on web and the list
// paints "Host not found" over a host that is right there.
const SHELL_HOST = {
  id: 'render-check-host',
  name: 'Render Check Host',
  endpoint: 'ws://render-check',
  lastConnected: 1
}

// The sharded `test` job does not install mobile dependencies, so the page cannot be built there.
// The CSP suite below needs none of them and still runs. pr.yml's mobile_web_app job runs both.
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

/**
 * Chunk paths the server answers with a module that throws on evaluation.
 *
 * The one way to reproduce the failure the boundary exists for: a route chunk that never arrives
 * intact. Building a second bundle around a throwing route would test a synthetic tree; poisoning
 * one file of the real bundle keeps everything else exactly what ships.
 */
const poisonedChunks = new Set()
const POISON_MESSAGE = 'render check poisoned this route chunk'

beforeAll(async () => {
  cspHeader = await readShellCsp()
  bridgeVersion = await readBridgeProtocolVersion()
  faultGrant = await readBridgeFaultGrant()
  if (!bundles) {
    return
  }
  scratch = await mkdtemp(join(tmpdir(), 'orca-mobile-web-app-render-'))
  const built = await buildMobileWebAppBundle({ outDir: join(scratch, 'bundle') })
  const { outDir } = built
  routeChunks = built.routeChunks
  // The real bytes with a throw in front: the module still links, so the importer resolves
  // every export it asked for and then evaluation throws. A body replaced outright fails at
  // link instead, which is a different failure from the one the boundary is here for.
  const served = await createBundleServer({
    outDir,
    cspHeader,
    transformChunk: (path, real) =>
      poisonedChunks.has(path)
        ? `throw new Error(${JSON.stringify(POISON_MESSAGE)});\n${real.toString('utf8')}`
        : real
  })
  server = served.server
  origin = served.origin
  // CI runs this against the runner's Google Chrome rather than paying for a browser download,
  // the same reason and the same override shape as the orcad browser-provider job.
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

// expo-router's Unmatched screen mounts cleanly and paints text, so "no errors, some html" stays
// green with every host route unreachable. Each route below names content only it can produce.
const UNMATCHED = 'Unmatched Route'

/**
 * A page with every signal the checks below read: uncaught errors, console errors, and the script
 * paths the browser actually fetched. The last one is how a client-side navigation proves it
 * pulled the next route's chunk rather than painting out of what the entry already had.
 *
 * No `shellRoute` installs no double at all, which is the page that never mounts; a null one
 * installs a shell that named no screen.
 */
async function openPage({ shellRoute, shellHost = SHELL_HOST, shellStorage = {} } = {}) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
  if (shellRoute !== undefined) {
    // At document start, where the native shell installs the real channel: the entry reads it
    // while its own script runs, so a channel added after `load` would already be too late.
    await page.addInitScript(installShellDouble, {
      version: bridgeVersion,
      sessionId: SHELL_SESSION_ID,
      buildId: SHELL_BUILD_ID,
      route: shellRoute,
      host: shellHost,
      storage: shellStorage,
      faultGrant
    })
  }
  const errors = []
  const scripts = []
  let reportUncaught = () => {}
  // An uncaught error from the entry means nothing will ever mount. Racing it against the wait
  // reports that error in a second instead of a 30s timeout that names nothing -- which is what a
  // native-only route module, throwing at import before React runs, looks like from here.
  // Resolved rather than rejected: this one settles during goto, before anything awaits it.
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
 * the route manifest defers every screen behind `import()`, so the entry's `mounted` signal lands
 * while the route's chunk is still being fetched and the body is briefly empty. Waiting for the
 * string the caller is about to assert is what makes the check about the route and not the timing.
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
  // The entry's own signal, not "#root has children": an error boundary or a half-painted tree
  // also fills #root, and this only lands once expo-router's tree below the wrapper has committed.
  // Polled on a timer rather than Playwright's default animation frames, which a page that never
  // paints never delivers.
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
  // Folded into the errors the caller already asserts empty: a throw the boundary caught paints
  // nothing and logs nothing a `pageerror` listener hears, so this is the only place it shows up.
  for (const fault of await page.evaluate(() => globalThis.__orcaRenderCheckFaults ?? [])) {
    errors.push(`page fault: ${fault}`)
  }
}

/**
 * Opens the document the way the shell does — at `/`, the one path it serves — and lets the page
 * route itself from what the double names. Navigating straight to the route would hide exactly the
 * step this check exists to prove.
 */
async function render(route, awaitText, { shellRoute = { pathname: route }, ...shell } = {}) {
  const opened = await openPage({ shellRoute, ...shell })
  await opened.page.goto(`${origin}/`, { waitUntil: 'load' })
  await waitForRoute(opened, route, awaitText)
  const text = await opened.page.evaluate(() => document.body.innerText)
  // What the page believes it is: read off the document rather than off the double, so a tree that
  // mounted without a session, or against a session it invented, is not a passing render.
  const session = await opened.page.evaluate(() => ({
    sessionId: document.documentElement.dataset.orcaWebSessionId ?? null,
    buildId: document.documentElement.dataset.orcaWebBuildId ?? null
  }))
  // The document is served at "/" and the page rewrites its own path before it renders; without
  // that, every route below would be expo-router's Unmatched screen.
  const url = await opened.page.evaluate(() => location.pathname + location.search)
  await opened.page.close()
  // A CSP refusal reaches the page as a console error, so the caller's empty-errors assertion is
  // also the policy assertion; name it here so a failure says which one broke.
  return {
    errors: opened.errors,
    cspErrors: opened.errors.filter((entry) => entry.includes('Content Security Policy')),
    text,
    session,
    url
  }
}

/** The entry's state and what it painted, for a page that is never going to mount a route tree. */
async function renderWithoutTree({ shellRoute } = {}) {
  const { page, errors } = await openPage({ shellRoute })
  // Read straight after `load` and not polled: the entry decides this synchronously, inside the
  // script `load` waits for, so a state that is not settled by now is never going to settle.
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

  it('still refuses inline script, which is the directive that matters', () => {
    expect(cspHeader).toContain("script-src 'self';")
    expect(cspHeader).not.toContain("script-src 'self' 'unsafe-inline'")
  })
})

describeRender('the page server this check runs against', () => {
  it('404s a file path the bundle does not contain', async () => {
    // Without this the document answers every path, and a publicPath the script cannot fetch
    // from still renders, because the script is fetched from the one prefix that is served.
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
    // The tree that mounted is the one the shell handed a session to, and it says which.
    expect(session).toEqual({ sessionId: SHELL_SESSION_ID, buildId: SHELL_BUILD_ID })
    // The document was served at `/`; the page put itself on the route the shell named.
    expect(url).toBe(HOST_ROUTE)
    // The host the shell named, read through host-store.web.ts off `init.host`. Only that route's
    // own component names the host; "Host not found" is what it paints without one.
    expect(text).toContain(SHELL_HOST.name)
    expect(text).not.toContain('Host not found')
    expect(text).not.toContain(UNMATCHED)
  }, 60_000)

  it('routes a nested dynamic segment through the same context', async () => {
    const { errors, cspErrors, text, session } = await render(`${HOST_ROUTE}/tasks`, 'Tasks')
    expect(cspErrors).toEqual([])
    expect(errors).toEqual([])
    expect(session.sessionId).toBe(SHELL_SESSION_ID)
    // app/h/[hostId]/tasks.tsx paints its header and its GitHub filter row.
    expect(text).toContain('Tasks')
    expect(text).toContain('Issues')
    expect(text).not.toContain(UNMATCHED)
  }, 60_000)

  it('renders the unmatched route rather than crashing on a path with no module', async () => {
    const { errors, cspErrors, text } = await render(`${HOST_ROUTE}/not-a-route`, UNMATCHED)
    expect(cspErrors).toEqual([])
    expect(errors).toEqual([])
    // Asserted positively so the two negatives above are known to discriminate.
    expect(text).toContain(UNMATCHED)
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
    // Without this the checks above would pass against a page that ignores `init` entirely.
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
    // Never the route tree at `/`: that is the Unmatched screen with a worse explanation.
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
      // The message the poisoned module threw, carried across the bridge as the shell sees it. A
      // boundary that caught the throw and reported something else would pass an "any fault" check.
      expect(reported.join(' | ')).toContain(POISON_MESSAGE)
      // And the screen never painted. The router's own shell commits before the deferred chunk
      // rejects, so the entry does reach `mounted`; what the boundary takes away is everything
      // below it, which is the difference between a reported failure and a blank page nobody hears.
      const text = await opened.page.evaluate(() => document.body.innerText)
      expect(text).not.toContain('Host not found')
      expect(text).not.toContain(UNMATCHED)
      await opened.page.close()
    } finally {
      poisonedChunks.delete(`/assets/${chunk}`)
    }
  }, 60_000)

  it("fetches the next route's chunks on a client-side navigation", async () => {
    const opened = await openPage({ shellRoute: { pathname: HOST_ROUTE } })
    const { page, errors, scripts } = opened
    await page.goto(`${origin}/`, { waitUntil: 'load' })
    await waitForRoute(opened, HOST_ROUTE, SHELL_HOST.name)
    const loadedForFirstRoute = [...scripts]
    // What the shell will do in C1.2: the document is fetched once and every later route is a
    // history entry, so the tasks screen can only arrive as a chunk fetched now.
    await page.evaluate((to) => {
      history.pushState(null, '', to)
      dispatchEvent(new PopStateEvent('popstate'))
    }, `${HOST_ROUTE}/tasks`)
    await waitForRoute(opened, `${HOST_ROUTE}/tasks`, 'Issues')
    expect(new URL(page.url()).pathname).toBe(`${HOST_ROUTE}/tasks`)
    const fetchedOnNavigation = scripts.filter((path) => !loadedForFirstRoute.includes(path))
    // Not "some script arrived": the chunk the builder put the tasks route in, named by the
    // builder rather than guessed from the bytes, which is the only thing that says the route
    // came over the wire now and not out of what the first route had already loaded.
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
