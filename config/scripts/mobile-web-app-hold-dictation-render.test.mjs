import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium } from 'playwright-core'
import { buildMobileWebAppBundle } from './build-mobile-web-app-bundle.mjs'
import { mobileWebAppDependenciesPresent } from './mobile-web-app-bundle-dependencies.mjs'
import {
  CHAT_MIC_ID,
  TERMINAL_MIC_ID,
  holdDictationProbeRouteSource
} from './mobile-web-app-hold-dictation-probe-route.mjs'
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
 * Hold-to-dictate on the page. Android WebView turns a held touch into a `contextmenu` about
 * 500 ms in; react-native-web reads that as a responder termination unless the Pressable declares
 * `onLongPress`, so the mic's press-out fires mid-hold and the recording stops.
 */

const PROBE_ROUTE = `/${MOBILE_WEB_APP_ROUTE_ROOT}/hold-dictation-probe`
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
  const cspHeader = await readShellCsp()
  bridgeVersion = await readBridgeProtocolVersion()
  faultGrant = await readBridgeFaultGrant()
  scratch = await mkdtemp(join(tmpdir(), 'orca-mobile-web-hold-dictation-'))
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
  const built = await buildMobileWebAppBundle({
    appDir,
    outDir: join(scratch, 'bundle'),
    pageRoutes: [{ pathname: PROBE_ROUTE, grants: [] }]
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

async function openProbe() {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true })
  await page.addInitScript(installShellDouble, {
    version: bridgeVersion,
    sessionId: 'hold-dictation-session',
    buildId: 'hold-dictation-build',
    route: { pathname: PROBE_ROUTE, params: {} },
    host: { id: 'hold-host', name: 'Hold Host', endpoint: 'ws://hold', lastConnected: 1 },
    storage: {},
    faultGrant,
    grants: [faultGrant],
    pageRoutes: [PROBE_ROUTE],
    replies: {}
  })
  const errors = []
  page.on('pageerror', (error) => errors.push(`${error.name}: ${error.message}`))
  await page.goto(`${origin}/`, { waitUntil: 'load' })
  await page.waitForFunction(
    () =>
      globalThis.__orcaHoldDictationProbe !== undefined ||
      (globalThis.__orcaRenderCheckFaults ?? []).length > 0,
    { timeout: 60_000, polling: 100 }
  )
  expect(await page.evaluate(() => globalThis.__orcaRenderCheckFaults ?? [])).toEqual([])
  return { errors, page }
}

/**
 * Touch-holds the mic, delivers Android's long-press `contextmenu` 600 ms in, reads mid-hold,
 * then lifts the finger. `contextMenuPrevented` stands in for the WebView's text selection, which
 * is that event's default action on a device and has none for a synthetic event here.
 */
async function holdThroughLongPress(page, selector) {
  // A handle, not a locator: the label the selector matches changes as soon as the press lands.
  const mic = await page.waitForSelector(selector)
  const box = await mic.boundingBox()
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  const input = await page.context().newCDPSession(page)
  await input.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] })
  await page.waitForTimeout(600)
  const contextMenuPrevented = await mic.evaluate((node, at) => {
    const event = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: at.x,
      clientY: at.y
    })
    return !node.dispatchEvent(event)
  }, point)
  await page.waitForTimeout(300)
  const midHold = {
    label: await mic.getAttribute('aria-label'),
    pressOuts: await page.evaluate(() => globalThis.__orcaHoldDictationProbe.pressOuts()),
    contextMenuPrevented,
    selection: await page.evaluate(() => document.getSelection()?.toString() ?? '')
  }
  await input.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await page.waitForTimeout(300)
  const pressOutsAfterRelease = await page.evaluate(() =>
    globalThis.__orcaHoldDictationProbe.pressOuts()
  )
  return { midHold, pressOutsAfterRelease }
}

describeRender(
  'hold-to-dictate on the page',
  () => {
    it('keeps the terminal mic recording through the long-press contextmenu', async () => {
      const { errors, page } = await openProbe()
      const { midHold, pressOutsAfterRelease } = await holdThroughLongPress(
        page,
        `#${TERMINAL_MIC_ID} [aria-label="Start voice dictation"]`
      )
      expect(midHold).toEqual({
        label: 'Stop voice dictation',
        pressOuts: { terminal: 0, chat: 0 },
        contextMenuPrevented: true,
        selection: ''
      })
      expect(pressOutsAfterRelease).toEqual({ terminal: 1, chat: 0 })
      expect(errors).toEqual([])
      await page.close()
    }, 300_000)

    it('keeps the chat mic recording through the long-press contextmenu', async () => {
      const { errors, page } = await openProbe()
      const { midHold, pressOutsAfterRelease } = await holdThroughLongPress(
        page,
        `#${CHAT_MIC_ID} [aria-label="Dictate"]`
      )
      expect(midHold).toEqual({
        label: 'Stop dictation',
        pressOuts: { terminal: 0, chat: 0 },
        contextMenuPrevented: true,
        selection: ''
      })
      // The icon under the finger swaps on press, so the release has to reach the Pressable.
      expect(pressOutsAfterRelease).toEqual({ terminal: 0, chat: 1 })
      expect(errors).toEqual([])
      await page.close()
    }, 300_000)
  },
  900_000
)
