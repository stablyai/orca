import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium } from 'playwright-core'
import { buildMobileWebAppBundle } from './build-mobile-web-app-bundle.mjs'
import { mobileWebAppDependenciesPresent } from './mobile-web-app-bundle-dependencies.mjs'
import {
  BROWSER_VIEWPORT_ID,
  CHAT_MIC_ID,
  REPEAT_KEY_LABEL,
  TAP_KEY_LABEL,
  TERMINAL_MIC_ID,
  accessoryKeyProbeRouteSource,
  browserPaneProbeRouteSource,
  holdDictationProbeRouteSource
} from './mobile-web-app-held-press-probe-routes.mjs'
import { MOBILE_WEB_APP_ROUTE_ROOT } from './mobile-web-app-route-manifest.mjs'
import {
  createBundleServer,
  installShellDouble,
  projectDir,
  readBridgeFaultGrant,
  readBridgeProtocolVersion,
  readShellCsp
} from './mobile-web-app-render-harness.mjs'
import { LAYOUT_SOURCE } from './mobile-web-app-terminal-probe-route.mjs'

/**
 * Held presses on the page. Held ~500 ms, Android WebView turns a touch into a long-press: it
 * starts a text selection, fires `contextmenu`, then cancels the touch, and react-native-web ends
 * the press on the selection and on the cancel. Traced on an emulator: none of it happens once the
 * element cancels its `touchstart`. Headless Chromium generates no long-press from CDP touches, so
 * `holdLikeAndroidWebView` plays that sequence itself, and only when `touchstart` went uncancelled.
 */

const ROUTES = {
  mic: `/${MOBILE_WEB_APP_ROUTE_ROOT}/hold-dictation-probe`,
  keys: `/${MOBILE_WEB_APP_ROUTE_ROOT}/accessory-key-probe`,
  browser: `/${MOBILE_WEB_APP_ROUTE_ROOT}/browser-pane-probe`
}
/** When Android WebView's long-press lands; its cancel follows ~20-50 ms later on the device. */
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
      chatComposerModule: join(sessionDir, 'MobileNativeChatComposer')
    })
  )
  await writeFile(
    join(routeDir, 'accessory-key-probe.tsx'),
    accessoryKeyProbeRouteSource({
      accessoryKeyModule: join(sessionDir, 'MobileTerminalAccessoryKey'),
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

async function openProbe(pathname, { initialDialog } = {}) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true })
  if (initialDialog) {
    await page.addInitScript((dialog) => {
      globalThis.__orcaHeldPressInitialDialog = dialog
    }, initialDialog)
  }
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
  return { errors, page }
}

/**
 * Touch-holds `selector` for `holdMs`, reads `read()` mid-hold, then lifts. At 500 ms it plays
 * Android WebView's long-press — `contextmenu`, then `touchcancel` — unless the element cancelled
 * its `touchstart`, which on the device is what keeps the WebView from producing that gesture.
 */
async function holdLikeAndroidWebView(page, selector, { holdMs, read }) {
  // A handle, not a locator: a label the selector matches can change as soon as the press lands.
  const target = await page.waitForSelector(selector)
  const box = await target.boundingBox()
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  await page.evaluate(() => {
    globalThis.__touchStartCancelled = null
    // Bubble phase on window, so every listener on the target has already run.
    window.addEventListener('touchstart', (event) => {
      globalThis.__touchStartCancelled = event.defaultPrevented
    })
  })
  const input = await page.context().newCDPSession(page)
  await input.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] })
  await page.waitForTimeout(LONG_PRESS_MS)
  const touchStartCancelled = await page.evaluate(() => globalThis.__touchStartCancelled)
  if (!touchStartCancelled) {
    await target.evaluate((node, at) => {
      node.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: at.x,
          clientY: at.y
        })
      )
    }, point)
    await input.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] })
  }
  await page.waitForTimeout(holdMs - LONG_PRESS_MS)
  const midHold = { touchStartCancelled, ...(await read(target)) }
  if (touchStartCancelled) {
    await input.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  }
  await page.waitForTimeout(300)
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
          touchStartCancelled: true,
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
          touchStartCancelled: true,
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
      const sentCount = async (page) =>
        (await page.evaluate(() => globalThis.__orcaHeldPressProbe.sent())).length

      it('keeps repeating a held arrow key until the finger lifts', async () => {
        const { errors, page } = await openProbe(ROUTES.keys)
        const { midHold, afterRelease } = await holdLikeAndroidWebView(
          page,
          `[aria-label="${REPEAT_KEY_LABEL}"]`,
          { holdMs: 1500, read: async () => ({ sent: await sentCount(page) }) }
        )
        // One send on press-in, then every 45 ms from 400 ms: ~25 by 1.5 s, against 1 when the
        // long-press ends the press before the first repeat.
        expect(midHold.sent).toBeGreaterThan(20)
        expect(midHold.touchStartCancelled).toBe(true)
        // Nothing more once the finger is up.
        expect(afterRelease.sent - midHold.sent).toBeLessThan(3)
        expect(errors).toEqual([])
        await page.close()
      }, 300_000)

      it('leaves a tap key its click, which the guard would cancel', async () => {
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

      it('right-clicks on a 1 s hold', async () => {
        const { errors, page } = await openProbe(ROUTES.browser)
        const { midHold } = await holdLikeAndroidWebView(page, `#${BROWSER_VIEWPORT_ID}`, {
          holdMs: 1000,
          read: async () => ({ toasts: await toasts(page) })
        })
        // The hook's timer is 550 ms, after the WebView's long-press would have ended the press.
        expect(midHold).toEqual({ touchStartCancelled: true, toasts: ['Right click'] })
        expect(errors).toEqual([])
        await page.close()
      }, 300_000)

      it("leaves a dialog's buttons their click", async () => {
        const { errors, page } = await openProbe(ROUTES.browser, {
          initialDialog: { dialogType: 'confirm', message: 'Leave?' }
        })
        const ok = await page.waitForSelector(`#${BROWSER_VIEWPORT_ID} >> text=OK`)
        const cancelled = await ok.evaluate((node) => {
          const event = new Event('touchstart', { bubbles: true, cancelable: true })
          node.dispatchEvent(event)
          return event.defaultPrevented
        })
        expect(cancelled).toBe(false)
        expect(errors).toEqual([])
        await page.close()
      }, 300_000)
    })
  },
  900_000
)
