import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium } from 'playwright-core'
import { buildMobileWebAppBundle } from '../build-mobile-web-app-bundle.mjs'
import { mobileWebAppDependenciesPresent } from './mobile-web-app-bundle-dependencies.mjs'
import { MOBILE_WEB_PAGE_ROUTES } from '../mobile-web-page-routes.mjs'
import {
  createBundleServer,
  installShellDouble,
  readBridgeFaultGrant,
  readBridgePageClientIdentity,
  readBridgeProtocolVersion,
  readShellCsp
} from './preview/mobile-web-app-render-harness.mjs'

// Serve real-shaped tab snapshot and terminal stream; no-RPC session-render never attaches terminal.
// Surface exists at mount but grid opens only after init. Placeholder client identity gates terminal.subscribe; null once left surface 0×0.
// One test pins subscription identity and another reads painted grid, avoiding chrome-only false passes.

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
const SCROLLBACK_MARKER = 'orca-terminal-init-marker'

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

const SCROLLBACK_EVENT = {
  type: 'scrollback',
  seq: 1,
  cols: 80,
  rows: 24,
  serialized: `${SCROLLBACK_MARKER}\r\n`,
  displayMode: 'phone'
}

// Read manifest grants so fixture stays aligned with route.
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

// Answer minimum startup reads and name both streams so assertions observe loaded session, not refusal/retry states.
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

// Serialized page function closes over nothing; xterm helper textarea measures one cell where canvas/WebGL exposes no text rows.
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

async function waitForSubscribe(page, method) {
  try {
    await page.waitForFunction(
      (name) => (globalThis.__orcaRenderCheckSubscribes ?? []).some((one) => one.method === name),
      method,
      // Streams normally open within a second; bound failure reporting with headroom rather than adding fixed wait.
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
      // Page claims placeholder only; native shell substitutes authenticated device identity as frame leaves.
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
      // Require xterm-screen created by init/term.open, not surface present at mount.
      // Await replay/resize before reading one-cell helper textarea; screen existence can precede measurable grid.
      await page.waitForFunction(
        () => {
          const cell = document.querySelector('#terminal-surface .xterm-helper-textarea')
          return (
            document.querySelector('.xterm-screen') !== null &&
            cell !== null &&
            cell.getBoundingClientRect().width > 0
          )
        },
        undefined,
        {
          timeout: 60_000,
          polling: 250
        }
      )
      const painted = await page.evaluate(readTerminalGrid)
      console.log('[terminal-init]', JSON.stringify(painted))
      // Catch emulator’s original 0×0 surface failure.
      expect(painted.surface.width).toBeGreaterThan(0)
      expect(painted.surface.height).toBeGreaterThan(0)
      // Match scrollback grid dimensions to reject defaults; terminal-render separately checks buffer bytes because WebGL exposes no text rows.
      expect(painted.grid).toEqual({ cols: SCROLLBACK_EVENT.cols, rows: SCROLLBACK_EVENT.rows })
      expect(errors).toEqual([])
      await page.close()
    }, 300_000)
  },
  900_000
)
