import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { buildMobileWebAppBundle } from '../build-mobile-web-app-bundle.mjs'
import { MOBILE_WEB_APP_ROUTE_ROOT } from './mobile-web-app-route-manifest.mjs'
import {
  COLS,
  CONTROL_SOURCE,
  LAYOUT_SOURCE,
  probeRouteSource,
  ROWS
} from './preview/mobile-web-app-terminal-probe-route.mjs'
import {
  createBundleServer,
  installCspViolationRecorder,
  installListenerRecorder,
  installPageErrorSentinel,
  installSchedulerRecorder,
  installShellDouble,
  readBridgeFaultGrant,
  readBridgeProtocolVersion,
  readShellCsp
} from './preview/mobile-web-app-render-harness.mjs'

// Keep all allocated state per fixture so parallel instances cannot share browser/server/scratch handles.

const projectDir = fileURLToPath(new URL('../../..', import.meta.url))
const mobileDir = join(projectDir, 'mobile')

export const PROBE_ROUTE = '/h/terminal-probe'
export const CONTROL_ROUTE = '/h/terminal-control'
const PAGE_ROUTE_PATTERNS = [PROBE_ROUTE, CONTROL_ROUTE]
const SHELL_SESSION_ID = 'terminal-render-session'
const SHELL_BUILD_ID = 'terminal-render-build'
const SHELL_HOST = {
  id: 'terminal-render-host',
  name: 'Terminal Render Host',
  endpoint: 'ws://terminal-render',
  lastConnected: 1
}

// Share reverse cleanup for close and partial setup rollback; await server close or socket retains Vitest worker.
async function closeTerminalRenderFixture({ browser, scratch, server }) {
  // Try every cleanup independently; failed browser close must not leak socket/scratch. Return first failure after all attempts.
  const failures = []
  const attempt = async (close) => {
    try {
      await close()
    } catch (error) {
      failures.push(error)
    }
  }
  await attempt(() => browser?.close())
  await attempt(
    () =>
      server &&
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
  )
  await attempt(() => rm(scratch, { recursive: true, force: true }))
  if (failures.length > 0) {
    throw failures[0]
  }
}

// Browser launches last and may fail after server/scratch allocation; rollback before rethrowing original error because caller has no fixture handle.
export async function startTerminalRenderFixture() {
  const cspHeader = await readShellCsp()
  const bridgeVersion = await readBridgeProtocolVersion()
  const faultGrant = await readBridgeFaultGrant()
  const scratch = await mkdtemp(join(tmpdir(), 'orca-c75-terminal-render-'))
  let browser = null
  let served = null
  try {
    const appDir = join(scratch, 'app')
    const routeDir = join(appDir, MOBILE_WEB_APP_ROUTE_ROOT)
    await mkdir(routeDir, { recursive: true })
    await writeFile(join(routeDir, '_layout.tsx'), LAYOUT_SOURCE)
    // Extensionless import selects web sibling; explicit .tsx would mount browser-incompatible WebView wrapper.
    await writeFile(
      join(routeDir, 'terminal-probe.tsx'),
      probeRouteSource(join(mobileDir, 'src', 'terminal', 'TerminalWebView'))
    )
    await writeFile(join(routeDir, 'terminal-control.tsx'), CONTROL_SOURCE)
    const built = await buildMobileWebAppBundle({
      appDir,
      outDir: join(scratch, 'bundle'),
      pageRoutes: [
        { pathname: PROBE_ROUTE, grants: [] },
        { pathname: CONTROL_ROUTE, grants: [] }
      ]
    })
    served = await createBundleServer({ outDir: built.outDir, cspHeader })
    const executablePath = process.env.ORCA_MOBILE_WEB_RENDER_BROWSER
    browser = await chromium.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {})
    })
  } catch (error) {
    // Rollback failure must not replace original setup error; cleanup is best-effort.
    await closeTerminalRenderFixture({ browser, scratch, server: served?.server }).catch(() => {})
    throw error
  }
  const { origin } = served

  async function openPage(
    pathname,
    { errorSentinel = false, listeners = false, scheduler = false, beforeNavigate } = {}
  ) {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
    await beforeNavigate?.(page)
    if (scheduler) {
      await page.addInitScript(installSchedulerRecorder)
    }
    if (listeners) {
      await page.addInitScript(installListenerRecorder)
    }
    await page.addInitScript(installCspViolationRecorder)
    if (errorSentinel) {
      await page.addInitScript(installPageErrorSentinel)
    }
    await page.addInitScript(installShellDouble, {
      version: bridgeVersion,
      sessionId: SHELL_SESSION_ID,
      buildId: SHELL_BUILD_ID,
      route: { pathname, params: {} },
      host: SHELL_HOST,
      storage: {},
      faultGrant,
      grants: [faultGrant],
      pageRoutes: PAGE_ROUTE_PATTERNS,
      replies: {}
    })
    const errors = []
    page.on('pageerror', (error) => errors.push(`${error.name}: ${error.message}`))
    page.on('console', (message) => {
      if (message.type() === 'error') {
        errors.push(`console.error: ${message.text()}`)
      }
    })
    await page.goto(`${origin}/`, { waitUntil: 'load' })
    await page.waitForFunction(() => document.documentElement.dataset.orcaWebEntry === 'mounted', {
      timeout: 60_000,
      polling: 250
    })
    return { errors, page }
  }

  async function openTerminal(options) {
    const opened = await openPage(PROBE_ROUTE, options)
    await opened.page.waitForFunction(() => globalThis.__orcaTerminalReady === true, {
      timeout: 60_000,
      polling: 100
    })
    return opened
  }

  return {
    openPage,
    openTerminal,
    close: () => closeTerminalRenderFixture({ browser, scratch, server: served.server })
  }
}

// Match session order: mount markup, send init, then await xterm engine. xterm opens only on host init, not component mount.
export async function openProbeTerminal(page) {
  await page.locator('#terminal-container').waitFor({ state: 'attached', timeout: 30_000 })
  await page.evaluate(
    ([cols, rows]) => globalThis.__orcaTerminalProbe.init(cols, rows, ''),
    [COLS, ROWS]
  )
  // Wait for attachment, not visibility: replacement surface reveals only after writes drain in awaitReady rAF chain.
  await page.locator('#terminal-surface .xterm').waitFor({ state: 'attached', timeout: 30_000 })
  await page.evaluate(() => globalThis.__orcaTerminalProbe.awaitReady())
}
