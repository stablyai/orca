import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, webkit } from 'playwright-core'
import { buildMobileWebAppBundle } from './build-mobile-web-app-bundle.mjs'
import { mobileWebAppDependenciesPresent } from './mobile-web-app-bundle-dependencies.mjs'
import {
  createBundleServer,
  installShellDouble,
  readBridgeFaultGrant,
  readBridgeProtocolVersion,
  readShellCsp
} from './mobile-web-app-render-harness.mjs'

const HOST_ROUTE = '/h/render-check-host'
const SHELL_HOST = {
  id: 'render-check-host',
  name: 'Render Check Host',
  endpoint: 'ws://render-check',
  lastConnected: 1
}

const VIEWPORT = { width: 390, height: 844 }

/**
 * Both engines, because the defect this pins is not engine-specific.
 *
 * `useAnimatedStyle` without a dependency array registers a Reanimated mapper with no inputs
 * (hook/useAnimatedStyle.js reads `updater.__closure`, which only the Babel plugin writes and
 * esbuild never does). The mapper then runs once and never again, so the sheet keeps whichever
 * translateY the first frame wrote. Chromium and WebKit both park it, so a Chromium-only pin
 * would go green on an engine-specific theory that is not what is happening.
 */
const ENGINES = [
  {
    name: 'chromium',
    // CI runs this against the runner's Google Chrome rather than paying for a browser download,
    // the same override shape as the render check next door.
    launch: () => {
      const executablePath = process.env.ORCA_MOBILE_WEB_RENDER_BROWSER
      return chromium.launch({
        headless: true,
        ...(executablePath ? { executablePath } : {})
      })
    }
  },
  { name: 'webkit', launch: () => webkit.launch({ headless: true }) }
]

const bundles = mobileWebAppDependenciesPresent()
const describeDrawer = bundles ? describe : describe.skip

let scratch
let server
let origin
let cspHeader = null
let bridgeVersion = null
let faultGrant = null

beforeAll(async () => {
  if (!bundles) {
    return
  }
  cspHeader = await readShellCsp()
  bridgeVersion = await readBridgeProtocolVersion()
  faultGrant = await readBridgeFaultGrant()
  scratch = await mkdtemp(join(tmpdir(), 'orca-mobile-web-app-drawer-'))
  const { outDir } = await buildMobileWebAppBundle({ outDir: join(scratch, 'bundle') })
  const served = await createBundleServer({ outDir, cspHeader })
  server = served.server
  origin = served.origin
}, 180_000)

afterAll(async () => {
  server?.close()
  if (scratch) {
    await rm(scratch, { recursive: true, force: true })
  }
})

/**
 * The sheet itself, by the name it gives itself.
 *
 * Not by its corner radius: that selected the sheet through a styling token, so a design change
 * to the radius would have turned this pin into `sheet: false` -- a failure naming the wrong
 * thing entirely. `testID` on the RN side renders as `data-testid`
 * (react-native-web createDOMProps/index.js:832).
 */
function readDrawer() {
  const handle = document.querySelector('[aria-label="Dismiss drawer"]')
  if (!handle) {
    return { open: false }
  }
  const sheet = document.querySelector('[data-testid="bottom-drawer-sheet"]')
  if (!sheet) {
    return { open: true, sheet: false }
  }
  const box = sheet.getBoundingClientRect()
  return {
    open: true,
    sheet: true,
    transform: getComputedStyle(sheet).transform,
    top: Math.round(box.top),
    bottom: Math.round(box.bottom),
    height: Math.round(box.height)
  }
}

/** The centre of the one leaf element whose whole text is `label`. */
function centreOf(label) {
  const leaf = [...document.querySelectorAll('*')].find(
    (element) => element.childElementCount === 0 && element.textContent === label
  )
  if (!leaf) {
    return null
  }
  const box = leaf.getBoundingClientRect()
  return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) }
}

describeDrawer('the bottom drawer on the page', () => {
  for (const engine of ENGINES) {
    it(`slides the sheet onto the screen in ${engine.name}`, async () => {
      const browser = await engine.launch()
      try {
        // Motion on, stated rather than inherited. Under `prefers-reduced-motion: reduce`
        // Reanimated finishes `withTiming` in one frame, so a mapper that only ever runs once
        // still lands on the final translateY and this pin would pass on the broken build.
        const page = await browser.newPage({
          viewport: VIEWPORT,
          reducedMotion: 'no-preference'
        })
        const errors = []
        page.on('pageerror', (error) => errors.push(`${error.name}: ${error.message}`))
        await page.addInitScript(installShellDouble, {
          version: bridgeVersion,
          sessionId: 'render-check-session',
          buildId: 'render-check-build',
          route: { pathname: HOST_ROUTE },
          host: SHELL_HOST,
          storage: {},
          faultGrant
        })
        await page.goto(`${origin}/`, { waitUntil: 'load' })
        // The precondition the assertions below rest on, read off the page rather than assumed.
        expect(
          await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)
        ).toBe(false)
        await page.waitForFunction(
          () => document.documentElement.dataset.orcaWebEntry === 'mounted',
          { timeout: 30_000, polling: 250 }
        )
        // The filter sheet, not the row's action sheet: both are the same MountedBottomDrawer, and
        // this one opens from the header, which needs nothing of the list's own layout.
        const chip = await page.waitForFunction(centreOf, 'Filter', {
          timeout: 30_000,
          polling: 250
        })
        const at = await chip.jsonValue()
        await page.mouse.click(at.x, at.y)
        const opened = await page
          .waitForFunction(
            () => {
              const handle = document.querySelector('[aria-label="Dismiss drawer"]')
              return handle ? true : null
            },
            { timeout: 10_000, polling: 100 }
          )
          .then(() => true)
        expect(opened, errors.join(' | ')).toBe(true)

        // The enter animation is 180ms; anything left parked after this is parked for good.
        await page.waitForTimeout(1_000)
        const drawer = await page.evaluate(readDrawer)
        expect(drawer.sheet, JSON.stringify(drawer)).toBe(true)
        // Reanimated's own write, once its mapper has run to the end of `progress`. The initial
        // inline style is a full viewport of translateY, so a mapper that stopped after its first
        // frame leaves a matrix here with a large offset instead of none.
        expect(drawer.transform, JSON.stringify(drawer)).toBe('matrix(1, 0, 0, 1, 0, 0)')
        // And where that leaves the sheet: bottom-anchored inside the viewport, which is the
        // thing the user sees and the thing a parked sheet gets wrong.
        expect(drawer.bottom, JSON.stringify(drawer)).toBe(VIEWPORT.height)
        expect(drawer.top, JSON.stringify(drawer)).toBeGreaterThan(0)
        expect(errors).toEqual([])
        await page.close()
      } finally {
        await browser.close()
      }
    }, 120_000)
  }
})
