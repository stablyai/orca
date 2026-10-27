import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium } from 'playwright-core'
import { buildMobileWebAppBundle } from '../build-mobile-web-app-bundle.mjs'
import { mobileWebAppDependenciesPresent } from './mobile-web-app-bundle-dependencies.mjs'
import {
  BROWSER_VIEWPORT_ID,
  CHAT_MIC_ID,
  REPEAT_KEY_LABEL,
  TAP_KEY_LABEL,
  TERMINAL_MIC_ID,
  browserPaneProbeRouteSource,
  commandDockProbeRouteSource,
  holdDictationProbeRouteSource
} from './preview/mobile-web-app-held-press-probe-routes.mjs'
import { MOBILE_WEB_APP_ROUTE_ROOT } from './mobile-web-app-route-manifest.mjs'
import {
  createBundleServer,
  installShellDouble,
  projectDir,
  readBridgeFaultGrant,
  readBridgeProtocolVersion,
  readShellCsp
} from './preview/mobile-web-app-render-harness.mjs'
import { LAYOUT_SOURCE } from './preview/mobile-web-app-terminal-probe-route.mjs'

// Android long-press (~500ms) emits contextmenu plus selection/touchcancel on selectable text; RN-Web ends press unless onLongPress refuses contextmenu.
// Native-parity CSS removes selection; headless CDP does not synthesize Android long-press, so holdLikeAndroidWebView replays observed sequence.

const ROUTES = {
  mic: `/${MOBILE_WEB_APP_ROUTE_ROOT}/hold-dictation-probe`,
  keys: `/${MOBILE_WEB_APP_ROUTE_ROOT}/command-dock-probe`,
  browser: `/${MOBILE_WEB_APP_ROUTE_ROOT}/browser-pane-probe`
}
/** When Android WebView's long-press lands; a selection's cancel follows ~20-50 ms later. */
const LONG_PRESS_MS = 500
const bundles = mobileWebAppDependenciesPresent()
const describeRender = bundles ? describe : describe.skip

let browser = null
let origin = null
let scratch = null
let server = null
let bridgeVersion = null
let faultGrant = null

beforeAll(async () => {
  if (!bundles) {
    return
  }
  const sessionDir = join(projectDir, 'mobile', 'src', 'session')
  const browserDir = join(projectDir, 'mobile', 'src', 'browser')
  const terminalDir = join(projectDir, 'mobile', 'src', 'terminal')
  const cspHeader = await readShellCsp()
  bridgeVersion = await readBridgeProtocolVersion()
  faultGrant = await readBridgeFaultGrant()
  scratch = await mkdtemp(join(tmpdir(), 'orca-mobile-web-held-press-'))
  const appDir = join(scratch, 'app')
  const routeDir = join(appDir, MOBILE_WEB_APP_ROUTE_ROOT)
  await mkdir(routeDir, { recursive: true })
  await writeFile(join(routeDir, '_layout.tsx'), LAYOUT_SOURCE)
  await writeFile(
    join(routeDir, 'hold-dictation-probe.tsx'),
    holdDictationProbeRouteSource({
      terminalActionsModule: join(sessionDir, 'MobileTerminalInputActions'),
      chatComposerModule: join(sessionDir, 'native-chat', 'composer', 'MobileNativeChatComposer')
    })
  )
  await writeFile(
    join(routeDir, 'command-dock-probe.tsx'),
    commandDockProbeRouteSource({
      commandDockModule: join(sessionDir, 'MobileSessionCommandDock'),
      keyDefinitionsModule: join(terminalDir, 'terminal-key-definitions')
    })
  )
  await writeFile(
    join(routeDir, 'browser-pane-probe.tsx'),
    browserPaneProbeRouteSource({
      paneViewModule: join(browserDir, 'MobileBrowserPaneView'),
      interactionsModule: join(browserDir, 'use-mobile-browser-interactions'),
      geometryModule: join(browserDir, 'browser-touch-geometry')
    })
  )
  const built = await buildMobileWebAppBundle({
    appDir,
    outDir: join(scratch, 'bundle'),
    pageRoutes: Object.values(ROUTES).map((pathname) => ({ pathname, grants: [] }))
  })
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

async function openProbe(pathname) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true })
  await page.addInitScript(installShellDouble, {
    version: bridgeVersion,
    sessionId: 'held-press-session',
    buildId: 'held-press-build',
    route: { pathname, params: {} },
    host: { id: 'held-host', name: 'Held Host', endpoint: 'ws://held', lastConnected: 1 },
    storage: {},
    faultGrant,
    grants: [faultGrant],
    pageRoutes: Object.values(ROUTES),
    replies: {}
  })
  const errors = []
  page.on('pageerror', (error) => errors.push(`${error.name}: ${error.message}`))
  await page.goto(`${origin}/`, { waitUntil: 'load' })
  await page.waitForFunction(
    () =>
      globalThis.__orcaHeldPressProbe !== undefined ||
      (globalThis.__orcaRenderCheckFaults ?? []).length > 0,
    { timeout: 60_000, polling: 100 }
  )
  expect(await page.evaluate(() => globalThis.__orcaRenderCheckFaults ?? [])).toEqual([])
  await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') })
  await page.clock.pauseAt(new Date('2026-01-01T00:00:01Z'))
  return { errors, page }
}

// Hold/read mid-press, then release; at 500ms replay contextmenu and selectionchange/touchcancel only for selectable text, matching Android WebView.
async function holdLikeAndroidWebView(page, selector, { holdMs, read }) {
  // A handle, not a locator: a label the selector matches can change as soon as the press lands.
  const target = await page.waitForSelector(selector)
  const box = await target.boundingBox()
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  const input = await page.context().newCDPSession(page)
  await input.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] })
  await page.clock.runFor(LONG_PRESS_MS)
  const selectable = await target.evaluate((node, at) => {
    node.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: at.x,
        clientY: at.y
      })
    )
    // The nearest explicit user-select up the tree decides, as Blink resolves `auto`.
    for (let element = node; element; element = element.parentElement) {
      const value = getComputedStyle(element).userSelect
      if (value && value !== 'auto') {
        return value !== 'none'
      }
    }
    return true
  }, point)
  if (selectable) {
    await page.evaluate(() => document.dispatchEvent(new Event('selectionchange')))
    await input.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] })
  }
  await page.clock.runFor(holdMs - LONG_PRESS_MS)
  const midHold = { selectable, ...(await read(target)) }
  if (!selectable) {
    await input.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  }
  await page.clock.runFor(300)
  return { midHold, afterRelease: await read(target) }
}

const pressOuts = (page) => page.evaluate(() => globalThis.__orcaHeldPressProbe.pressOuts())

describeRender(
  'held presses on the page',
  () => {
    describe('hold-to-dictate', () => {
      it('keeps the terminal mic held until the finger lifts', async () => {
        const { errors, page } = await openProbe(ROUTES.mic)
        const { midHold, afterRelease } = await holdLikeAndroidWebView(
          page,
          `#${TERMINAL_MIC_ID} [aria-label="Start voice dictation"]`,
          {
            holdMs: 1500,
            read: async (mic) => ({
              label: await mic.getAttribute('aria-label'),
              pressOuts: await pressOuts(page)
            })
          }
        )
        expect(midHold).toEqual({
          selectable: false,
          label: 'Stop voice dictation',
          pressOuts: { terminal: 0, chat: 0 }
        })
        expect(afterRelease.pressOuts).toEqual({ terminal: 1, chat: 0 })
        expect(errors).toEqual([])
        await page.close()
      }, 300_000)

      it('keeps the chat mic held until the finger lifts', async () => {
        const { errors, page } = await openProbe(ROUTES.mic)
        const { midHold, afterRelease } = await holdLikeAndroidWebView(
          page,
          `#${CHAT_MIC_ID} [aria-label="Dictate"]`,
          {
            holdMs: 1500,
            read: async (mic) => ({
              label: await mic.getAttribute('aria-label'),
              pressOuts: await pressOuts(page)
            })
          }
        )
        expect(midHold).toEqual({
          selectable: false,
          label: 'Stop dictation',
          pressOuts: { terminal: 0, chat: 0 }
        })
        // The icon under the finger swaps on press, so the release has to reach the Pressable.
        expect(afterRelease.pressOuts).toEqual({ terminal: 0, chat: 1 })
        expect(errors).toEqual([])
        await page.close()
      }, 300_000)
    })

    describe('the key bar', () => {
      it('starts repeat on press and stops it only when the finger lifts', async () => {
        const { errors, page } = await openProbe(ROUTES.keys)
        const { midHold, afterRelease } = await holdLikeAndroidWebView(
          page,
          `[aria-label="${REPEAT_KEY_LABEL}"]`,
          {
            holdMs: 1500,
            read: () =>
              page.evaluate(() => ({
                sent: globalThis.__orcaHeldPressProbe.sent(),
                repeats: globalThis.__orcaHeldPressProbe.repeats()
              }))
          }
        )
        expect(midHold).toEqual({
          selectable: false,
          sent: ['\x1b[A'],
          repeats: [{ kind: 'start', bytes: '\x1b[A' }]
        })
        expect(afterRelease.sent).toEqual(['\x1b[A'])
        expect(afterRelease.repeats).toEqual([{ kind: 'start', bytes: '\x1b[A' }, { kind: 'stop' }])
        expect(errors).toEqual([])
        await page.close()
      }, 300_000)

      it('selects nothing on a long-press of a tap key', async () => {
        const { errors, page } = await openProbe(ROUTES.keys)
        const { midHold } = await holdLikeAndroidWebView(page, `[aria-label="${TAP_KEY_LABEL}"]`, {
          holdMs: 1000,
          read: () => page.evaluate(() => ({ selection: window.getSelection()?.toString() ?? '' }))
        })
        expect(midHold).toEqual({ selectable: false, selection: '' })
        expect(errors).toEqual([])
        await page.close()
      }, 300_000)

      it('sends a tapped key once', async () => {
        const { errors, page } = await openProbe(ROUTES.keys)
        const key = await page.waitForSelector(`[aria-label="${TAP_KEY_LABEL}"]`)
        await key.tap()
        await page.waitForFunction(() => globalThis.__orcaHeldPressProbe.sent().length === 1)
        expect(await page.evaluate(() => globalThis.__orcaHeldPressProbe.sent())).toEqual(['\x1b'])
        expect(errors).toEqual([])
        await page.close()
      }, 300_000)
    })

    describe('the browser pane', () => {
      const toasts = (page) => page.evaluate(() => globalThis.__orcaHeldPressProbe.toasts())
      const clicks = (page) =>
        page.evaluate(() =>
          globalThis.__orcaHeldPressProbe
            .requests()
            .filter((request) => request.method === 'browser.mouseClick')
            .map((request) => ({ button: request.params.button, page: request.params.page }))
        )

      it('right-clicks on a 1 s hold', async () => {
        const { errors, page } = await openProbe(ROUTES.browser)
        const { midHold, afterRelease } = await holdLikeAndroidWebView(
          page,
          `#${BROWSER_VIEWPORT_ID}`,
          {
            holdMs: 1000,
            read: async () => ({ toasts: await toasts(page), clicks: await clicks(page) })
          }
        )
        // The hook's timer is 550 ms, after the WebView's long-press would have ended the press.
        const rightClick = { button: 'right', page: 'held-press-page' }
        expect(midHold).toEqual({
          selectable: false,
          toasts: ['Right click'],
          clicks: [rightClick]
        })
        // The release after a right-click sends no left click.
        expect(afterRelease.clicks).toEqual([rightClick])
        expect(errors).toEqual([])
        await page.close()
      }, 300_000)

      it('left-clicks once on a tap', async () => {
        const { errors, page } = await openProbe(ROUTES.browser)
        const viewport = await page.waitForSelector(`#${BROWSER_VIEWPORT_ID}`)
        await viewport.tap()
        await page.waitForFunction(() => globalThis.__orcaHeldPressProbe.requests().length > 0)
        expect(await clicks(page)).toEqual([{ button: 'left', page: 'held-press-page' }])
        expect(await toasts(page)).toEqual([])
        expect(errors).toEqual([])
        await page.close()
      }, 300_000)
    })
  },
  900_000
)
