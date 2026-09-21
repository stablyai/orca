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
 * The agent-history page route in a real browser.
 *
 * Its own file rather than more cases in the render check next door: three domain series now append
 * browser cases to that one file, each under the `.mjs` line cap alone, and the merge of any two of
 * them is not. C1.10 extracted the harness so a domain gets a file; this is C5's.
 *
 * What lives here is what only a browser can answer for this route: that every module in its
 * closure evaluates under React Native Web, that the screen paints from replies the desktop would
 * really send, that its Back button reaches the shell, and that its chunk arrives over the wire.
 */

const HOST_ROUTE = '/h/render-check-host'
/** The pattern `init.pageRoutes` names, which is what the page matches a navigation against. */
const HOST_ROUTE_PATTERN = '/h/[hostId]'
const SHELL_SESSION_ID = 'render-check-session'
const SHELL_BUILD_ID = 'render-check-build'
const SHELL_HOST = {
  id: 'render-check-host',
  name: 'Render Check Host',
  endpoint: 'ws://render-check',
  lastConnected: 1
}
const UNMATCHED = 'Unmatched Route'
const ROUTE_KEY = './h/[hostId]/agent-history/[worktreeId].tsx'

/**
 * What the desktop answers, lifted from the recorded corpus rather than written here.
 *
 * Every body below is a reply scripted in `mobile/rpc-foundation/pilot-scenarios.json` — the
 * session list and worktree list from `aivault-history-screen-listed`, the status fields from
 * `transport-host-status-gates-ready` — which is the same shape the readers were built against. Authoring them here is how a fixture ends up wrong in a way the screen tolerates: a
 * locked-terminal reply written by hand in the seam test resolved instead of throwing, because the
 * flag it set was one level off the shape the reader reads.
 *
 * `wt-history` and `/repo/feature` travel together for the same reason. The panel opens on the
 * `workspace` scope and derives its filter paths from the worktree list, so the session is in scope
 * only when the route's worktree is the one whose path is the session's `cwd`. Opened on any other
 * worktree these same replies paint "No agent sessions" — a green mount that proves nothing.
 */
const HISTORY_WORKTREE = 'wt-history'
const SESSION_TITLE = 'Fix the explorer'
const CORPUS_REPLIES = {
  // Two scenarios merged, because two readers read this one method and neither reply carries what
  // the other needs. `transport-host-status-gates-ready` is what `HostProtocolGate` above every
  // host route reads: with only the capability list it decides this desktop is too old and paints
  // "Update Orca on your computer" over the route, which is what the screen showed first. The
  // capability is `aivault-history-screen-listed`'s, and it is what opens the panel's own gate.
  'status.get': {
    protocolVersion: 5,
    minCompatibleMobileVersion: 1,
    appVersion: '1.4.200',
    capabilities: ['aiVault.v1'],
    floatingWorkspaceEnabled: true
  },
  'worktree.ps': {
    worktrees: [
      { worktreeId: HISTORY_WORKTREE, path: '/repo/feature', repoId: 'repo-1' },
      { worktreeId: 'wt-2', path: '/repo/sibling', repoId: 'repo-1' }
    ]
  },
  'aiVault.listSessions': {
    sessions: [
      {
        id: 's1',
        executionHostId: 'local',
        agent: 'claude',
        sessionId: 'sess-1',
        title: SESSION_TITLE,
        cwd: '/repo/feature',
        branch: 'feature',
        model: 'opus',
        filePath: '/repo/feature/.claude/sess-1.jsonl',
        codexHome: null,
        createdAt: '2025-12-31T23:00:00.000Z',
        updatedAt: '2025-12-31T23:30:00.000Z',
        modifiedAt: '2025-12-31T23:30:00.000Z',
        messageCount: 4,
        totalTokens: 1200,
        previewMessages: [{ role: 'user', text: 'fix it', timestamp: '2025-12-31T23:00:00.000Z' }]
      }
    ],
    issues: []
  }
}

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
  scratch = await mkdtemp(join(tmpdir(), 'orca-mobile-web-app-agent-history-'))
  const built = await buildMobileWebAppBundle({ outDir: join(scratch, 'bundle') })
  routeChunks = built.routeChunks
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

/** Every grant-gated notify the page posted, whole and in order, as the shell received them. */
function readNotifies(page) {
  return page.evaluate(() => globalThis.__orcaRenderCheckNotifies ?? [])
}

describeRender('the agent-history route in a real browser', () => {
  /**
   * What this proves, exactly: every module in the route's closure imports and evaluates under
   * React Native Web, and the panel's own chrome paints. The unit tests mock react-native,
   * safe-area, svg, lucide and the icon assets away — they have to, react-native is Flow source
   * vitest cannot parse — so import-time breakage had no test anywhere until this one.
   *
   * This case answers no RPC, so the panel paints its "Unable to Load" state; the case below it
   * scripts the corpus replies and renders a row. What stays uncovered after both is the resume
   * path and the scope tabs, which need taps and a second scripted turn, and which C5.3 covers on
   * device against the native list.
   */
  it('mounts the route, whose panel no unit test renders for real', async () => {
    const route = `${HOST_ROUTE}/agent-history/wt-1`
    const opened = await openRoute(route, 'Agent Session History', {
      shellRoute: { pathname: route, params: { name: 'my worktree' } }
    })
    const text = await opened.page.evaluate(() => document.body.innerText)
    const url = await opened.page.evaluate(() => location.pathname + location.search)
    const session = await opened.page.evaluate(
      () => document.documentElement.dataset.orcaWebSessionId ?? null
    )
    expect(opened.errors.filter((entry) => entry.includes('Content Security Policy'))).toEqual([])
    expect(opened.errors).toEqual([])
    expect(session).toBe(SHELL_SESSION_ID)
    // The params half reaches the screen, not just the url: the subtitle is the worktree label.
    expect(url).toBe(`${route}?name=my+worktree`)
    expect(text).toContain('Agent Session History')
    expect(text).toContain('my worktree')
    expect(text).not.toContain(UNMATCHED)
    await opened.page.close()
  }, 60_000)

  it('paints a session row from the replies the desktop would really send', async () => {
    const route = `${HOST_ROUTE}/agent-history/${HISTORY_WORKTREE}`
    const opened = await openRoute(route, SESSION_TITLE, { replies: CORPUS_REPLIES })
    const text = await opened.page.evaluate(() => document.body.innerText)
    expect(opened.errors).toEqual([])
    expect(text).toContain(SESSION_TITLE)
    // The row's own fields, so a screen that painted the title from somewhere else fails here.
    expect(text).toContain('4 messages')
    // Positively asserted, because both of the states this case is not in are silent: the scan
    // failing paints "Unable to Load" and an out-of-scope session paints "No agent sessions".
    expect(text).not.toContain('Unable to Load')
    expect(text).not.toContain('No agent sessions')
    await opened.page.close()
  }, 60_000)

  it('hands its Back button to the shell, which no unit test can prove in a browser', async () => {
    const route = `${HOST_ROUTE}/agent-history/wt-1`
    const opened = await openRoute(route, 'Agent Session History', {
      shellGrants: [faultGrant, 'navigate'],
      shellPageRoutes: [HOST_ROUTE_PATTERN]
    })
    await opened.page.getByLabel('Back').click()
    // Nothing to wait for but the absence of a navigation, so settle the microtask the notify
    // would have posted on and then read the page that is still there.
    await opened.page.waitForTimeout(1_000)
    expect(await readNotifies(opened.page)).toEqual([
      { v: bridgeVersion, type: 'notify', name: 'navigate-back' }
    ])
    // Handed over, not taken: the document holds the single entry the entry wrote with
    // `replaceState`, so a Back this page served itself would have gone nowhere and looked alike.
    expect(await opened.page.evaluate(() => location.pathname)).toBe(route)
    expect(opened.errors).toEqual([])
    await opened.page.close()
  }, 60_000)

  it('posts nothing for Back when the shell granted no navigate, and stays put', async () => {
    // The absence that makes the case above evidence: with the grant withheld the same tap reaches
    // the same handler and the same seam, and the only thing that changes is the frame.
    const route = `${HOST_ROUTE}/agent-history/wt-1`
    const opened = await openRoute(route, 'Agent Session History')
    await opened.page.getByLabel('Back').click()
    await opened.page.waitForTimeout(1_000)
    expect(await readNotifies(opened.page)).toEqual([])
    expect(await opened.page.evaluate(() => location.pathname)).toBe(route)
    expect(opened.errors).toEqual([])
    await opened.page.close()
  }, 60_000)

  it("fetches the route's own chunk when the page navigates to it", async () => {
    // C5 is the first series whose success path pulls a second chunk after the first paint, which
    // on iOS goes through WKURLSchemeHandler under `script-src 'self'`.
    const opened = await openRoute(HOST_ROUTE, SHELL_HOST.name)
    const loadedForFirstRoute = [...opened.scripts]
    const route = `${HOST_ROUTE}/agent-history/wt-1`
    await opened.page.evaluate((to) => {
      history.pushState(null, '', to)
      dispatchEvent(new PopStateEvent('popstate'))
    }, route)
    await waitForRoute(opened, route, 'Agent Session History')
    const chunk = routeChunks[ROUTE_KEY]
    expect(chunk, Object.keys(routeChunks).join(' ')).toBeTruthy()
    const fetchedOnNavigation = opened.scripts.filter((path) => !loadedForFirstRoute.includes(path))
    // Named by the builder rather than guessed from the bytes, and absent from what the first
    // route loaded, which is what says the route came over the wire now.
    expect(fetchedOnNavigation, opened.scripts.join(' ')).toContain(`/assets/${chunk}`)
    expect(loadedForFirstRoute).not.toContain(`/assets/${chunk}`)
    expect(opened.errors).toEqual([])
    await opened.page.close()
  }, 60_000)
})
