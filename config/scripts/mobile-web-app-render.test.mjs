import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium } from 'playwright-core'
import { fileURLToPath } from 'node:url'
import { buildMobileWebAppBundle } from './build-mobile-web-app-bundle.mjs'
import { mobileWebAppDependenciesPresent } from './mobile-web-app-bundle-dependencies.mjs'

const projectDir = fileURLToPath(new URL('../..', import.meta.url))

// Why a real browser: the route tree is handed to expo-router's own ExpoRoot through a synthesized
// RequireContext. Nothing short of mounting it proves that object is the shape ExpoRoot reads.
const HOST_ROUTE = '/h/render-check-host'

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

/**
 * Both CSP constants are a list of quoted directives with `//` comments between them, and those
 * comments quote directive text. Dropping comment lines first is what keeps a comment out of the
 * header this test serves.
 */
export function parseCspDirectives(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker)
  const end = source.indexOf(endMarker)
  if (start === -1 || end < start) {
    throw new Error(`could not find ${startMarker} .. ${endMarker}`)
  }
  const body = source
    .slice(start, end)
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n')
  const directives = [...body.matchAll(/"([^"]+)"/g)].map((match) => match[1])
  if (directives.length < 10) {
    throw new Error('could not parse the shell CSP')
  }
  return directives.join('; ')
}

/**
 * The shipped policy, read from the Kotlin source so this test cannot drift from what the shell
 * actually sends. Parsed rather than imported: the constant lives in a JVM module.
 */
async function readShellCsp() {
  const source = await readFile(
    join(
      projectDir,
      'mobile/modules/orca-mobile-web-shell/android/src/main/java/expo/modules/orcamobilewebshell/MobileWebShellCsp.kt'
    ),
    'utf8'
  )
  return parseCspDirectives(source, 'listOf(', ').joinToString')
}

beforeAll(async () => {
  cspHeader = await readShellCsp()
  if (!bundles) {
    return
  }
  scratch = await mkdtemp(join(tmpdir(), 'orca-mobile-web-app-render-'))
  const built = await buildMobileWebAppBundle({ outDir: join(scratch, 'bundle') })
  const { outDir } = built
  routeChunks = built.routeChunks
  server = createServer((request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname
    // A browser asks for this on its own and the shell's WebView never does. The bundle carries
    // no icon, so a 404 would put a console error in every check that runs against a full Chrome
    // -- which is what CI resolves -- and none against the bundled headless shell.
    if (path === '/favicon.ico') {
      response.writeHead(204)
      response.end()
      return
    }
    // A route path serves the entrypoint and the page routes client-side. A path naming a file
    // has to come out of the bundle or 404, the same as the shell's manifest map: answering it
    // with the document instead would hide a publicPath the script cannot fetch from.
    const namesAFile = path.slice(path.lastIndexOf('/')).includes('.')
    const file = namesAFile ? path.slice(1) : 'index.html'
    readFile(join(outDir, file)).then(
      (bytes) => {
        const headers = {
          'content-type': file.endsWith('.js') ? 'text/javascript' : 'text/html'
        }
        // The document carries the shell's real policy, so a directive the page violates fails
        // here rather than on a phone. Assets carry none, exactly as the native handler does.
        if (file === 'index.html' && cspHeader) {
          headers['content-security-policy'] = cspHeader
        }
        response.writeHead(200, headers)
        response.end(bytes)
      },
      () => {
        response.writeHead(404)
        response.end()
      }
    )
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${String(server.address().port)}`
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
 */
async function openPage() {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
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
}

async function render(route, awaitText) {
  const opened = await openPage()
  await opened.page.goto(`${origin}${route}`, { waitUntil: 'load' })
  await waitForRoute(opened, route, awaitText)
  const text = await opened.page.evaluate(() => document.body.innerText)
  await opened.page.close()
  // A CSP refusal reaches the page as a console error, so the caller's empty-errors assertion is
  // also the policy assertion; name it here so a failure says which one broke.
  return {
    errors: opened.errors,
    cspErrors: opened.errors.filter((entry) => entry.includes('Content Security Policy')),
    text
  }
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
    const { errors, cspErrors, text } = await render(HOST_ROUTE, 'Host not found')
    expect(cspErrors).toEqual([])
    expect(errors).toEqual([])
    // app/h/[hostId]/index.tsx: the placeholder client knows no host, so the list paints its
    // not-found state. Only that route's own component produces this string.
    expect(text).toContain('Host not found')
    expect(text).not.toContain(UNMATCHED)
  }, 60_000)

  it('routes a nested dynamic segment through the same context', async () => {
    const { errors, cspErrors, text } = await render(`${HOST_ROUTE}/tasks`, 'Tasks')
    expect(cspErrors).toEqual([])
    expect(errors).toEqual([])
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

  it("fetches the next route's chunks on a client-side navigation", async () => {
    const opened = await openPage()
    const { page, errors, scripts } = opened
    await page.goto(`${origin}${HOST_ROUTE}`, { waitUntil: 'load' })
    await waitForRoute(opened, HOST_ROUTE, 'Host not found')
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
