import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium } from 'playwright-core'
import { buildMobileWebAppBundle } from '../../build/mobile-web-app/build-mobile-web-app-bundle.mjs'
import { mobileWebAppDependenciesPresent } from '../mobile-web-app-bundle-dependencies.mjs'
import {
  REPEAT_KEY_LABEL,
  commandDockProbeRouteSource
} from '../preview/mobile-web-app-held-press-probe-routes.mjs'
import { MOBILE_WEB_APP_ROUTE_ROOT } from '../mobile-web-app-route-manifest.mjs'
import {
  createBundleServer,
  installShellDouble,
  projectDir,
  readBridgeFaultGrant,
  readBridgeProtocolVersion,
  readShellCsp
} from '../preview/mobile-web-app-render-harness.mjs'
import { LAYOUT_SOURCE } from '../preview/mobile-web-app-terminal-probe-route.mjs'

const ROUTES = {
  keys: `/${MOBILE_WEB_APP_ROUTE_ROOT}/command-dock-probe`
}
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
    join(routeDir, 'command-dock-probe.tsx'),
    commandDockProbeRouteSource({
      commandDockModule: join(sessionDir, 'MobileSessionCommandDock'),
      keyDefinitionsModule: join(terminalDir, 'terminal-key-definitions'),
      accessorySelectionModule: join(sessionDir, 'use-mobile-session-accessory-selection'),
      dockKeysModule: join(sessionDir, 'use-terminal-dock-keys'),
      liveInputCaptureModule: join(sessionDir, 'live-input-capture')
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

describeRender(
  'held presses on the page',
  () => {
    describe('the key bar', () => {
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
    })
  },
  900_000
)
