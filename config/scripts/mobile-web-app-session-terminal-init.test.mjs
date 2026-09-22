import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium } from 'playwright-core'
import { buildMobileWebAppBundle } from './build-mobile-web-app-bundle.mjs'
import { mobileWebAppDependenciesPresent } from './mobile-web-app-bundle-dependencies.mjs'
import { MOBILE_WEB_PAGE_ROUTES } from './mobile-web-page-routes.mjs'
import {
  createBundleServer,
  installShellDouble,
  readBridgeFaultGrant,
  readBridgePageClientIdentity,
  readBridgeProtocolVersion,
  readShellCsp
} from './mobile-web-app-render-harness.mjs'

/**
 * The session route's terminal, driven from a shell double that answers the streams a host does.
 *
 * `mobile-web-app-session-render.test.mjs` mounts this route against a double that answers no RPC,
 * so its terminal never attaches and it says so. This is the other half: a tab snapshot with one
 * terminal in it, and a `terminal.subscribe` stream the double serves. Both are the shapes the page
 * reads, not the host's — the double decides no behaviour, it only carries what this file wrote.
 *
 * The oracle is the document, not the route's chrome: `#terminal-surface` exists the moment the
 * component mounts, and it stays 0x0 with no children until the document receives `init`. So the
 * check is that the surface has a real grid, which is exactly what the hybrid RC emulator run did
 * not get — `[fit]measure-fail` with `notReady: true`, a document that answered a measure with no
 * `term` because no `init` had ever reached it.
 *
 * What made it red: the page's client provider answered `getClientId` with `null`, and
 * `use-mobile-session-terminal-subscription.ts` refuses to subscribe without a client identity. No
 * `terminal.subscribe`, no `scrollback`, no `init`. The first case below is the narrow one and
 * catches a regression at its source; the second reads the painted grid.
 */

const HOST_ID = 'terminal-init-host'
const WORKTREE = 'wt-1'
const SESSION_ROUTE = `/h/${HOST_ID}/session/${WORKTREE}`
const SESSION_PATTERN = '/h/[hostId]/session/[worktreeId]'
const PAGE_ROUTE_PATTERNS = [SESSION_PATTERN]
const SHELL_SESSION_ID = 'terminal-init-session'
const SHELL_BUILD_ID = 'terminal-init-build'
const SHELL_HOST = {
  id: HOST_ID,
  name: 'Terminal Init Host',
  endpoint: 'ws://terminal-init',
  lastConnected: 1
}
const HANDLE = 'pty-handle-terminal-init'
const TAB_ID = 'tab-terminal-init'
/** The bytes the snapshot carries, so the buffer the document opens holds this run's fixture. */
const SCROLLBACK_MARKER = 'orca-terminal-init-marker'

/** The tab snapshot the route applies, in the shape `applySessionTabs` reads off the stream. */
const TABS_SNAPSHOT = {
  type: 'snapshot',
  worktree: `id:${WORKTREE}`,
  publicationEpoch: 'terminal-init-epoch',
  snapshotVersion: 1,
  activeTabId: TAB_ID,
  activeTabType: 'terminal',
  tabs: [
    {
      type: 'terminal',
      id: TAB_ID,
      title: 'bash',
      terminal: HANDLE,
      status: 'ready',
      isActive: true
    }
  ]
}

/** The first stream event a live terminal sends, which is what carries `init` into the document. */
const SCROLLBACK_EVENT = {
  type: 'scrollback',
  seq: 1,
  cols: 80,
  rows: 24,
  serialized: `${SCROLLBACK_MARKER}\r\n`,
  displayMode: 'phone'
}

/** Read off the manifest rather than restated, for the reason the session render check reads it. */
function sessionGrants() {
  const declared = MOBILE_WEB_PAGE_ROUTES.find((route) => route.pathname === SESSION_PATTERN)
  if (!declared) {
    throw new Error(`${SESSION_PATTERN} is not registered`)
  }
  return declared.grants
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
let pageClientIdentity = null

beforeAll(async () => {
  if (!bundles) {
    return
  }
  cspHeader = await readShellCsp()
  bridgeVersion = await readBridgeProtocolVersion()
  faultGrant = await readBridgeFaultGrant()
  pageClientIdentity = await readBridgePageClientIdentity()
  scratch = await mkdtemp(join(tmpdir(), 'orca-mobile-web-app-terminal-init-'))
  const built = await buildMobileWebAppBundle({ outDir: join(scratch, 'bundle') })
  const served = await createBundleServer({ outDir: built.outDir, cspHeader })
  server = served.server
  origin = served.origin
  const executablePath = process.env.ORCA_MOBILE_WEB_RENDER_BROWSER
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) })
}, 600_000)

afterAll(async () => {
  await browser?.close()
  server?.close()
  if (scratch) {
    await rm(scratch, { recursive: true, force: true })
  }
})

/**
 * The session route, mounted, with its tab snapshot already applied.
 *
 * The two streams are named so the double accepts them instead of refusing; the replies are the
 * reads the screen makes on the way up, each answered with the least the screen needs so nothing
 * below is looking at a retry or an error state.
 */
async function openSessionWithTerminalTab() {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
  await page.addInitScript(installShellDouble, {
    version: bridgeVersion,
    sessionId: SHELL_SESSION_ID,
    buildId: SHELL_BUILD_ID,
    route: { pathname: SESSION_ROUTE },
    host: SHELL_HOST,
    storage: {},
    faultGrant,
    grants: [faultGrant, ...sessionGrants()],
    pageRoutes: PAGE_ROUTE_PATTERNS,
    // The page claims an identity only against a shell that says it swaps one in.
    accepts: [pageClientIdentity.accept],
    streams: ['session.tabs.subscribe', 'terminal.subscribe'],
    replies: {
      'worktree.show': { worktree: { id: WORKTREE, name: WORKTREE, path: `/tmp/${WORKTREE}` } },
      'terminal.list': {
        terminals: [{ handle: HANDLE, title: 'bash', worktree: `id:${WORKTREE}` }]
      }
    }
  })
  const errors = []
  page.on('pageerror', (error) => errors.push(`${error.name}: ${error.message}`))
  await page.goto(`${origin}/`, { waitUntil: 'load' })
  await page.waitForFunction(
    () => document.documentElement.dataset.orcaWebEntry === 'mounted',
    undefined,
    { timeout: 60_000, polling: 250 }
  )
  const tabs = await waitForSubscribe(page, 'session.tabs.subscribe')
  await page.evaluate(
    ([id, event]) => globalThis.__orcaRenderCheckEmitEvent(id, event),
    [tabs.id, TABS_SNAPSHOT]
  )
  return { errors, page }
}

/**
 * The surface's box, and the grid xterm opened inside it, in cells.
 *
 * Serialized into the page, so it closes over nothing. The screen is sized in pixels and the helper
 * textarea is exactly one cell, which is how a cell count is read back from a renderer that paints
 * to a canvas and leaves no row elements to count.
 */
function readTerminalGrid() {
  const surface = document.getElementById('terminal-surface')
  const box = surface.getBoundingClientRect()
  const read = { surface: { width: Math.round(box.width), height: Math.round(box.height) } }
  const screen = surface.querySelector('.xterm-screen')
  const cell = surface.querySelector('.xterm-helper-textarea')
  if (!screen || !cell) {
    return { ...read, grid: null }
  }
  const cellBox = cell.getBoundingClientRect()
  if (cellBox.width <= 0 || cellBox.height <= 0) {
    return { ...read, grid: null }
  }
  const screenBox = screen.getBoundingClientRect()
  return {
    ...read,
    grid: {
      cols: Math.round(screenBox.width / cellBox.width),
      rows: Math.round(screenBox.height / cellBox.height)
    }
  }
}

/** The stream the page opened for `method`, or a failure naming every stream it did open. */
async function waitForSubscribe(page, method) {
  try {
    await page.waitForFunction(
      (name) => (globalThis.__orcaRenderCheckSubscribes ?? []).some((one) => one.method === name),
      method,
      // Both streams open within a second of the mount they follow, so this is headroom rather
      // than a wait: what it bounds is how long a broken attach path takes to say so.
      { timeout: 30_000, polling: 100 }
    )
  } catch {
    const opened = await page.evaluate(() => globalThis.__orcaRenderCheckSubscribes ?? [])
    throw new Error(
      `the page never subscribed to ${method}; it opened: ${
        opened.map((one) => one.method).join(', ') || 'nothing'
      }`
    )
  }
  const found = await page.evaluate(
    (name) => (globalThis.__orcaRenderCheckSubscribes ?? []).find((one) => one.method === name),
    method
  )
  return found
}

describeRender(
  'the session route attaches its terminal on the page',
  () => {
    it('subscribes to the terminal the tab snapshot named, carrying a client identity', async () => {
      const { page } = await openSessionWithTerminalTab()
      const subscribe = await waitForSubscribe(page, 'terminal.subscribe')
      expect(subscribe.params.terminal).toBe(HANDLE)
      // The gate that was closed, and the exact string the page may claim. It is the placeholder
      // and never the credential: the native shell swaps in this device's real identity as the
      // frame leaves it, which is what the host compares against the socket it authenticated.
      expect(subscribe.params.client).toEqual({
        id: pageClientIdentity.placeholder,
        type: 'mobile'
      })
      await page.close()
    }, 300_000)

    it('receives init in the document and measures a non-zero grid', async () => {
      const { errors, page } = await openSessionWithTerminalTab()
      const subscribe = await waitForSubscribe(page, 'terminal.subscribe')
      await page.evaluate(
        ([id, event]) => globalThis.__orcaRenderCheckEmitEvent(id, event),
        [subscribe.id, SCROLLBACK_EVENT]
      )
      // The surface exists from the moment the component mounts, so its presence proves nothing.
      // `.xterm-screen` does: it is created by `term.open()`, which only ever runs from the
      // document's `init`. The emulator run had the surface with zero children inside a correctly
      // sized container, which is this element missing.
      await page.waitForFunction(
        () => document.querySelector('.xterm-screen') !== null,
        undefined,
        {
          timeout: 60_000,
          polling: 250
        }
      )
      const painted = await page.evaluate(readTerminalGrid)
      console.log('[terminal-init]', JSON.stringify(painted))
      // The box the emulator read as 0x0.
      expect(painted.surface.width).toBeGreaterThan(0)
      expect(painted.surface.height).toBeGreaterThan(0)
      // And the grid it opened, which is the one this run's scrollback named: the screen is sized
      // in cells, so a document that opened on its own defaults rather than on this event would
      // report a different pair. This is what the terminal renders through — under WebGL there are
      // no row elements and no text on the document, so the bytes in the buffer are
      // `mobile-web-app-terminal-render.test.mjs`'s oracle and the attach path is this one's.
      expect(painted.grid).toEqual({ cols: SCROLLBACK_EVENT.cols, rows: SCROLLBACK_EVENT.rows })
      expect(errors).toEqual([])
      await page.close()
    }, 300_000)
  },
  900_000
)
