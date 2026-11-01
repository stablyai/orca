import { mkdtemp, rm } from 'node:fs/promises'
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
  readBridgeFaultGrant,
  readBridgePagePainted,
  readBridgeProtocolVersion,
  readShellCsp
} from './preview/mobile-web-app-render-harness.mjs'

// Browser-only history checks prove real RN-Web closure evaluation, corpus-backed rows, shell Back handoff and deferred chunk delivery.
// Domain file uses shared C1.10 harness to avoid line-cap conflicts between concurrent series.

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

// Use recorded pilot-scenario RPC replies: hand-authored seam fixtures once set a locked flag at the wrong level and falsely passed.
// Match session cwd to route worktree path; otherwise workspace-scope filtering paints an empty list and proves no row rendering.
const HISTORY_WORKTREE = 'wt-history'
const SESSION_TITLE = 'Fix the explorer'
const CORPUS_REPLIES = {
  // Merge status fields with history capabilities: HostProtocolGate otherwise paints update-required before panel’s own gate opens.
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
let paintName = null

beforeAll(async () => {
  if (!bundles) {
    return
  }
  cspHeader = await readShellCsp()
  bridgeVersion = await readBridgeProtocolVersion()
  faultGrant = await readBridgeFaultGrant()
  paintName = await readBridgePagePainted()
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
  // Install channel at document start; entry reads it during evaluation, before load.
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

// Wait beyond entry mount for route content; deferred import chunk may still be arriving.
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

/** Every grant-gated notify the page posted, whole and in order, as the shell received them. The
 *  paint report is not one: every page posts it once its route screen has a frame. */
async function readNotifies(page) {
  const notifies = await page.evaluate(() => globalThis.__orcaRenderCheckNotifies ?? [])
  return notifies.filter((frame) => frame.name !== paintName)
}

describeRender('the agent-history route in a real browser', () => {
  // Prove real RN-Web import/evaluation absent from mocked native units; no-RPC case paints failure, next corpus case paints a row.
  // Resume/scope-tab interactions remain native C5.3 device coverage.
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
    // Assert populated state explicitly; failed scan and out-of-scope session both paint silent empty/error states.
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
    await expect
      .poll(() => readNotifies(opened.page))
      .toEqual([{ v: bridgeVersion, type: 'notify', name: 'navigate-back' }])
    expect(await readNotifies(opened.page)).toEqual([
      { v: bridgeVersion, type: 'notify', name: 'navigate-back' }
    ])
    // Document has only replaceState entry; page-local Back would do nothing and look like a successful shell handoff.
    expect(await opened.page.evaluate(() => location.pathname)).toBe(route)
    expect(opened.errors).toEqual([])
    await opened.page.close()
  }, 60_000)

  it('posts nothing for Back when the shell granted no navigate, and stays put', async () => {
    // Withhold grant while preserving tap/handler/seam to prove handoff depends on permission.
    const route = `${HOST_ROUTE}/agent-history/wt-1`
    const opened = await openRoute(route, 'Agent Session History')
    await opened.page.getByLabel('Back').click()
    await waitForPageFrames(opened.page)
    expect(await readNotifies(opened.page)).toEqual([])
    expect(await opened.page.evaluate(() => location.pathname)).toBe(route)
    expect(opened.errors).toEqual([])
    await opened.page.close()
  }, 60_000)

  it("fetches the route's own chunk when the page navigates to it", async () => {
    // History success loads another post-paint chunk; iOS delivers it through WKURLSchemeHandler under script-src self.
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
    // Use builder-owned chunk identity and require it absent initially to prove a new wire fetch.
    expect(fetchedOnNavigation, opened.scripts.join(' ')).toContain(`/assets/${chunk}`)
    expect(loadedForFirstRoute).not.toContain(`/assets/${chunk}`)
    expect(opened.errors).toEqual([])
    await opened.page.close()
  }, 60_000)
})
