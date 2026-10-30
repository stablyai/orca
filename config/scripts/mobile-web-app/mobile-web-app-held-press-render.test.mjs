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
      keyDefinitionsModule: join(terminalDir, 'terminal-key-definitions'),
      accessorySelectionModule: join(sessionDir, 'use-mobile-session-accessory-selection')
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
  await target.scrollIntoViewIfNeeded()
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

async function beginRepeatKeyTouch(page) {
  const key = await page.waitForSelector(`[aria-label="${REPEAT_KEY_LABEL}"]`)
  await key.scrollIntoViewIfNeeded()
  const box = await key.boundingBox()
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  const input = await page.context().newCDPSession(page)
  await input.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] })
  return { input, key, point }
}

const keyScrollOffset = (key) =>
  key.evaluate((node) => {
    for (let parent = node.parentElement; parent; parent = parent.parentElement) {
      if (
        parent.scrollWidth > parent.clientWidth &&
        getComputedStyle(parent).overflowX !== 'visible'
      ) {
        return parent.scrollLeft
      }
    }
    throw new Error('Key bar does not overflow')
  })

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
      it('repeats a held key without an extra send when the finger lifts', async () => {
        const { errors, page } = await openProbe(ROUTES.keys)
        const { midHold, afterRelease } = await holdLikeAndroidWebView(
          page,
          `[aria-label="${REPEAT_KEY_LABEL}"]`,
          {
            holdMs: 1500,
            read: () =>
              page.evaluate(() => ({
                repeats: globalThis.__orcaHeldPressProbe.repeats(),
                sent: globalThis.__orcaHeldPressProbe.sent()
              }))
          }
        )
        expect(midHold).toEqual({
          selectable: false,
          repeats: [{ kind: 'start', bytes: '\x1b[A' }],
          sent: expect.arrayContaining(['\x1b[A'])
        })
        expect(midHold.sent.length).toBeGreaterThan(1)
        expect(afterRelease.sent).toEqual(midHold.sent)
        expect(afterRelease.repeats).toEqual([{ kind: 'start', bytes: '\x1b[A' }, { kind: 'stop' }])
        expect(errors).toEqual([])
        await page.close()
      }, 300_000)

      it('sends a repeatable tap once on release without waiting for the hold delay', async () => {
        const { errors, page } = await openProbe(ROUTES.keys)
        const { input } = await beginRepeatKeyTouch(page)
        await page.clock.runFor(100)
        expect(await page.evaluate(() => globalThis.__orcaHeldPressProbe.sent())).toEqual([])
        await input.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
        await page.clock.runFor(1)
        expect(await page.evaluate(() => globalThis.__orcaHeldPressProbe.sent())).toEqual([
          '\x1b[A'
        ])
        await page.clock.runFor(1000)
        expect(await page.evaluate(() => globalThis.__orcaHeldPressProbe.sent())).toEqual([
          '\x1b[A'
        ])
        expect(errors).toEqual([])
        await page.close()
      }, 300_000)

      it('does not repeat after movement cancels long-press recognition', async () => {
        const { errors, page } = await openProbe(ROUTES.keys)
        const { input, point } = await beginRepeatKeyTouch(page)
        await page.clock.runFor(100)
        await input.send('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: [{ ...point, y: point.y + 20 }]
        })
        await page.clock.runFor(1000)
        expect(await page.evaluate(() => globalThis.__orcaHeldPressProbe.sent())).toEqual([])
        await input.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
        await page.clock.runFor(1000)
        expect(
          await page.evaluate(() => globalThis.__orcaHeldPressProbe.sent().length)
        ).toBeLessThanOrEqual(1)
        expect(errors).toEqual([])
        await page.close()
      }, 300_000)

      it('drops a prepared tap after switching terminals and accepts a new accessibility click', async () => {
        const { errors, page } = await openProbe(ROUTES.keys)
        const { input, key } = await beginRepeatKeyTouch(page)
        await page.clock.runFor(100)
        await page.evaluate(() => globalThis.__orcaHeldPressProbe.switchTerminal())
        await page.waitForFunction(
          () => globalThis.__orcaHeldPressProbe.activeHandle === 'other-terminal'
        )
        await input.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
        await page.clock.runFor(1000)
        expect(await page.evaluate(() => globalThis.__orcaHeldPressProbe.sent())).toEqual([])
        await key.evaluate((node) => node.click())
        expect(await page.evaluate(() => globalThis.__orcaHeldPressProbe.deliveries())).toEqual([
          { bytes: '\x1b[A', target: 'other-terminal' }
        ])
        expect(errors).toEqual([])
        await page.close()
      }, 300_000)

      it.each([
        [100, false],
        [700, false],
        [700, true]
      ])(
        'keeps Enter activation bound to keydown terminal with hold=%sms and switch=%s',
        async (holdMs, switchTerminal) => {
          const { errors, page } = await openProbe(ROUTES.keys)
          const key = await page.waitForSelector(`[aria-label="${REPEAT_KEY_LABEL}"]`)
          await key.focus()
          await page.keyboard.down('Enter')
          await page.clock.runFor(100)
          expect(await page.evaluate(() => globalThis.__orcaHeldPressProbe.deliveries())).toEqual([
            { bytes: '\x1b[A', target: 'held-press-terminal' }
          ])
          if (switchTerminal) {
            await page.evaluate(() => globalThis.__orcaHeldPressProbe.switchTerminal())
            await page.waitForFunction(
              () => globalThis.__orcaHeldPressProbe.activeHandle === 'other-terminal'
            )
          }
          await page.clock.runFor(holdMs - 100)
          const beforeRelease = await page.evaluate(() =>
            globalThis.__orcaHeldPressProbe.deliveries()
          )
          if (holdMs === 100 || switchTerminal) {
            expect(beforeRelease).toHaveLength(1)
          } else {
            expect(beforeRelease.length).toBeGreaterThan(1)
          }
          expect(beforeRelease).toEqual(
            beforeRelease.map(() => ({ bytes: '\x1b[A', target: 'held-press-terminal' }))
          )
          await page.keyboard.up('Enter')
          await page.clock.runFor(1000)
          expect(errors).toEqual([])
          expect(await page.evaluate(() => globalThis.__orcaHeldPressProbe.deliveries())).toEqual(
            beforeRelease
          )
          await page.close()
        },
        300_000
      )

      it('scrolls across a repeatable key without sending it', async () => {
        const { errors, page } = await openProbe(ROUTES.keys)
        const { input, key, point } = await beginRepeatKeyTouch(page)
        const before = await keyScrollOffset(key)
        await page.clock.runFor(70)
        for (let step = 1; step <= 8; step += 1) {
          await input.send('Input.dispatchTouchEvent', {
            type: 'touchMove',
            touchPoints: [{ ...point, x: point.x - step * 20 }]
          })
          await page.clock.runFor(20)
        }
        await input.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
        await page.clock.runFor(1000)
        expect(await keyScrollOffset(key)).toBeGreaterThan(before)
        expect(await page.evaluate(() => globalThis.__orcaHeldPressProbe.sent())).toEqual([])
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
