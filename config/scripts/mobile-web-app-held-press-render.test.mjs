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
 * Hold-to-dictate on the page. Held ~500 ms, Android WebView turns a touch into a long-press: it
 * starts a text selection on the nearest text and then cancels the touch, and react-native-web ends
 * the press on either, so the mic's press-out stops the recording mid-hold. Cancelling the mic's
 * `touchstart` is what stops the WebView generating that gesture (traced on an emulator); headless
 * Chromium generates no long-press from CDP touches, so the check reads the cancel itself.
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

/** Touch-holds the mic for 1.5 s, reads the press mid-hold, then lifts the finger. */
async function holdAndRelease(page, selector) {
  // A handle, not a locator: the label the selector matches changes as soon as the press lands.
  const mic = await page.waitForSelector(selector)
  const box = await mic.boundingBox()
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
  await page.waitForTimeout(1500)
  const midHold = {
    label: await mic.getAttribute('aria-label'),
    pressOuts: await page.evaluate(() => globalThis.__orcaHoldDictationProbe.pressOuts()),
    touchStartCancelled: await page.evaluate(() => globalThis.__touchStartCancelled),
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
    it('keeps the terminal mic held until the finger lifts', async () => {
      const { errors, page } = await openProbe()
      const { midHold, pressOutsAfterRelease } = await holdAndRelease(
        page,
        `#${TERMINAL_MIC_ID} [aria-label="Start voice dictation"]`
      )
      expect(midHold).toEqual({
        label: 'Stop voice dictation',
        pressOuts: { terminal: 0, chat: 0 },
        touchStartCancelled: true,
        selection: ''
      })
      expect(pressOutsAfterRelease).toEqual({ terminal: 1, chat: 0 })
      expect(errors).toEqual([])
      await page.close()
    }, 300_000)

    it('keeps the chat mic held until the finger lifts', async () => {
      const { errors, page } = await openProbe()
      const { midHold, pressOutsAfterRelease } = await holdAndRelease(
        page,
        `#${CHAT_MIC_ID} [aria-label="Dictate"]`
      )
      expect(midHold).toEqual({
        label: 'Stop dictation',
        pressOuts: { terminal: 0, chat: 0 },
        touchStartCancelled: true,
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
