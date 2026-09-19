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
/** The pattern `init.pageRoutes` names, which is what the page matches a navigation against. */
const HOST_ROUTE_PATTERN = '/h/[hostId]'

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
async function openPage({
  shellRoute,
  shellHost = SHELL_HOST,
  shellStorage = {},
  shellGrants,
  shellPageRoutes = null
} = {}) {
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
      faultGrant,
      grants: shellGrants ?? [faultGrant],
      pageRoutes: shellPageRoutes
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

  it('admits data: for images and for nothing else', () => {
    expect(cspHeader.split('; ').filter((entry) => entry.includes('data:'))).toEqual([
      "img-src 'self' data:"
    ])
  })
})

/** A 1x1 PNG: the smallest payload that proves an image decoded rather than merely being allowed. */
const DATA_URI_IMAGE =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

describeRender('an image preview under the shell policy', () => {
  it('decodes a data: URI, which is the only shape a file preview has', async () => {
    // What a preview actually is: normalizeMobileFilePreviewResult composes
    // `data:<mime>;base64,<content>` out of a reply the page already holds and hands it to React
    // Native Web's Image, which paints it as a CSS background. The `new Image()` below is not a
    // stand-in for that: react-native-web 0.21.2 loads through `ImageLoader.load`, which is
    // `new window.Image()` with `onload`/`onerror` on it, and the hidden <img> the component also
    // renders carries neither — it is there for the browser's image context menu and for
    // `getBackgroundSize()`. So this is the same mechanism the screen's own load runs through, and
    // its failure is what turns the screen into "Unable to load preview".
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

  it('fills the view, so what it mounted is painted and takes a tap', async () => {
    const opened = await openPage({ shellRoute: { pathname: HOST_ROUTE } })
    await opened.page.goto(`${origin}/`, { waitUntil: 'load' })
    await waitForRoute(opened, HOST_ROUTE, SHELL_HOST.name)
    const layout = await opened.page.evaluate(() => {
      // The one control this route paints with no RPC answered. Positioned against the bottom of
      // the root, so it is also the element a collapsed root moves furthest.
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
    // Nothing else here can see a collapsed root: the tree mounts, the text is in the DOM, and
    // every assertion on `innerText` passes while the phone paints a blank list under the header.
    // A height is the only thing that says the screen is on the screen.
    expect(layout.rootHeight).toBe(layout.viewportHeight)
    expect(layout.fabTop).toBeGreaterThan(0)
    expect(layout.fabBottom).toBeLessThanOrEqual(layout.viewportHeight)
    // Laid out is not reachable. A row inside a scroller the collapse clipped keeps its rect and
    // takes no taps, which is what both phones found before this file could say so.
    expect(layout.reachesTheControl).toBe(true)
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

  it('refuses a target the shell will not take, rather than opening it in the page', async () => {
    // The double grants only `fault`, so `notifyNavigate` answers false -- the shell-disposed and
    // older-shell cases reach the page the same way. Before C5.1 this left the host route and
    // painted Unmatched; the bundle carries every route under app/h, so for a target like
    // `session/[worktreeId]` the same fallback mounts a native-only screen on React Native Web.
    const opened = await openPage({ shellRoute: { pathname: HOST_ROUTE } })
    const { page, errors } = opened
    await page.goto(`${origin}/`, { waitUntil: 'load' })
    await waitForRoute(opened, HOST_ROUTE, SHELL_HOST.name)
    // The one labelled control on this screen that leaves the page: `leaveHostRoute` dismisses to
    // `/`, which is a native route and never one the page serves.
    await page.getByLabel('Back to hosts').click()
    // Nothing to wait for but the absence of a navigation, so settle the microtask the handoff
    // would have posted on and then read the page that is still there.
    await page.waitForTimeout(1_000)
    expect(await page.evaluate(() => location.pathname)).toBe(HOST_ROUTE)
    const text = await page.evaluate(() => document.body.innerText)
    expect(text).toContain(SHELL_HOST.name)
    expect(text).not.toContain(UNMATCHED)
    // The absence that says refused rather than handed off. A page that stayed put because the
    // notify crossed and the shell did the pushing looks identical on this document otherwise;
    // the case below it grants `navigate` and asserts this same frame present.
    const notifies = await page.evaluate(() => globalThis.__orcaRenderCheckNotifies ?? [])
    expect(notifies.filter((frame) => frame.name === 'navigate')).toEqual([])
    // Not a page fault either: a refused target is the page declining to move, not a throw.
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

/**
 * What `useRouteHandoff().back()` rests on, measured in a browser rather than assumed.
 *
 * The handoff keeps a back this document can serve and hands the rest to the shell, and it asks
 * expo-router's `canGoBack()` which of the two it is holding. That answer is React Navigation's
 * (`expo-router/build/global-state/routing.js` returns `navigationRef.current.canGoBack()`), so it
 * is a fact about a mounted tree in a browser and no unit test can settle it.
 *
 * Read through `router.back()` rather than through `canGoBack()` directly, because the page exposes
 * no handle to call it on and a global added for a test is a surface the shipped page would carry
 * forever. `goBack()` queues React Navigation's `GO_BACK`, which is exactly what `canGoBack()`
 * gates: a Back that moves the page proves the answer was true, one that does not proves it was
 * false. `/h/[hostId]/edit` is the call site — a real route of this tree whose chevron is
 * expo-router's own `back()`, which is what the handoff falls through to.
 *
 * The first case is the presence precondition for the two below it. A tap that moved nothing and a
 * tap that never reached a handler look identical on the document, so one tap on this same screen
 * family is asserted to reach the shell before any absence is read as an answer.
 */
describeRender('the stack the page Back button rests on', () => {
  const EDIT_ROUTE = `${HOST_ROUTE}/edit`
  const BACK_ON_EDIT = '[aria-label="Back"]'

  /** Clicks and then lets the router settle; a `GO_BACK` that changes nothing settles too. */
  async function clickAndSettle(page, selector) {
    await page.click(selector)
    await page.waitForTimeout(500)
    return page.evaluate(() => location.pathname + location.search)
  }

  it('carries a handoff the shell granted across the bridge from a real tap', async () => {
    // The `navigate` grant is what `navigate-back` rides, and this chevron is the one control in
    // the page tree that reaches the shell through `useRouteHandoff` today. It proves taps land,
    // handlers run and a notify crosses — the mechanism `navigate-back` uses, and the reason the
    // two absences below are evidence rather than silence.
    const opened = await openPage({
      shellRoute: { pathname: HOST_ROUTE },
      shellGrants: [faultGrant, 'navigate'],
      shellPageRoutes: [HOST_ROUTE_PATTERN]
    })
    await opened.page.goto(`${origin}/`, { waitUntil: 'load' })
    await waitForRoute(opened, HOST_ROUTE, SHELL_HOST.name)
    const url = await clickAndSettle(opened.page, '[aria-label="Back to hosts"]')
    const notifies = await opened.page.evaluate(() => globalThis.__orcaRenderCheckNotifies ?? [])
    expect(notifies.filter((frame) => frame.name === 'navigate')).toEqual([
      { v: bridgeVersion, type: 'notify', name: 'navigate', href: '/' }
    ])
    // Handed over, not taken: the page stayed where it was rather than routing to a screen it does
    // not carry, which is what a fallthrough to the local router would have painted.
    expect(url).toBe(HOST_ROUTE)
    expect(opened.errors).toEqual([])
    await opened.page.close()
  }, 60_000)

  it('cannot go back on the document the shell just opened, which is the one screen it has', async () => {
    const opened = await openPage({ shellRoute: { pathname: EDIT_ROUTE } })
    await opened.page.goto(`${origin}/`, { waitUntil: 'load' })
    await waitForRoute(opened, EDIT_ROUTE, 'Edit host')
    // One control, so the tap below is known to be this route's chevron and not another screen's.
    expect(await opened.page.locator(BACK_ON_EDIT).count()).toBe(1)
    expect(await clickAndSettle(opened.page, BACK_ON_EDIT)).toBe(EDIT_ROUTE)
    expect(opened.errors).toEqual([])
    await opened.page.close()
  }, 60_000)

  it('is given no stack by a location change either, only by a push this page makes itself', async () => {
    // The entry opens every document with `replaceState`, and a later location change resets the
    // router's state rather than stacking on it: the same chevron still has nowhere to go with a
    // second entry in `history`. So `canGoBack()` is false for everything the shell or the browser
    // can do to this page, and the handoff's local branch belongs to a push the page makes through
    // `useRouteHandoff` — of which this tree has none today.
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
    // This case drives a synthetic `popstate`, so a throw under the fault boundary would leave the
    // page exactly where the assertion above wants it and read as the absence this claims.
    expect(opened.errors).toEqual([])
    await opened.page.close()
  }, 60_000)
})
