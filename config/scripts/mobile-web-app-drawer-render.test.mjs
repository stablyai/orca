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

/**
 * Installed at document start, so the counters cover the page's whole life rather than a window
 * a poll happened to catch. Both are the page's own activity: `__raf` is every frame the page
 * asked for, `__sheetWrites` every inline-style write Reanimated landed on the sheet.
 */
function instrumentFrames() {
  globalThis.__raf = 0
  const realRaf = globalThis.requestAnimationFrame.bind(globalThis)
  globalThis.requestAnimationFrame = (callback) => {
    globalThis.__raf++
    return realRaf(callback)
  }
  globalThis.__sheetWrites = 0
  const observe = () => {
    new MutationObserver((records) => {
      for (const record of records) {
        if (record.target.dataset?.testid === 'bottom-drawer-sheet') {
          globalThis.__sheetWrites++
        }
      }
    }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['style'] })
  }
  if (document.body) {
    observe()
  } else {
    document.addEventListener('DOMContentLoaded', observe)
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
        // Context-level and before navigation, both load-bearing: Reanimated latches the query
        // into a module-level const at import (ReducedMotion.js:8-10), so an `emulateMedia` call
        // after `goto` would leave the assertion below passing over an already-latched `true`.
        const page = await browser.newPage({
          viewport: VIEWPORT,
          reducedMotion: 'no-preference'
        })
        const errors = []
        page.on('pageerror', (error) => errors.push(`${error.name}: ${error.message}`))
        await page.addInitScript(instrumentFrames)
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
        // Both counters start at the click, so what they measure is the enter animation's window
        // and not everything the page did while it was booting.
        await page.evaluate(() => {
          globalThis.__rafAtClick = globalThis.__raf
          globalThis.__sheetWrites = 0
        })
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

        // Wait for the animation to arrive rather than for a clock. A fixed pause makes the pin
        // a race on a loaded runner: too short and a healthy-but-slow engine reads as parked,
        // and the failure names the transform instead of the wait. A sheet that is genuinely
        // parked never moves, so this times out and the assertions below still report what it
        // found -- the same red, minus the timing assumption.
        await page
          .waitForFunction(
            () => {
              const sheet = document.querySelector('[data-testid="bottom-drawer-sheet"]')
              return sheet && getComputedStyle(sheet).transform === 'matrix(1, 0, 0, 1, 0, 0)'
                ? true
                : null
            },
            { timeout: 15_000, polling: 50 }
          )
          .catch(() => null)
        const drawer = await page.evaluate(readDrawer)
        expect(drawer.sheet, JSON.stringify(drawer)).toBe(true)

        // The precondition, named, because the transform below cannot on its own tell a mapper
        // that is not subscribed from an engine that never ran the animation at all. Both leave
        // a parked sheet and only the first is this pin's subject.
        //
        // `requestAnimationFrame` is the one that separates them. `withTiming` drives itself by
        // scheduling a frame per step (valueSetter.js `step`), and it does that whether or not
        // any mapper is listening, so frames during this window mean the shared value moved.
        // Sheet writes separate nothing and are carried as context only. The broken build writes
        // once, an engine that never animated writes once, and -- measured under `--cpus=0.35`
        // in Playwright's Linux image -- a healthy page starved of frames also reaches
        // translateY(0) in a single write, because `withTiming` covers the whole 180ms in one
        // step when that is all the frames it gets. Asserting on the count would red that page.
        const frames = await page.evaluate(() => ({
          raf: globalThis.__raf - globalThis.__rafAtClick,
          sheetWrites: globalThis.__sheetWrites
        }))
        expect(
          frames.raf,
          `${engine.name}: the page was given no animation frames after the sheet opened, so ` +
            'the enter animation never ran and the transform proves nothing about the mapper'
        ).toBeGreaterThan(0)

        // Reanimated's own write, once its mapper has run to the end of `progress`. The initial
        // inline style is a full viewport of translateY, so a mapper that stopped after its first
        // frame leaves a matrix here with a large offset instead of none.
        expect(
          drawer.transform,
          `${engine.name}: ${String(frames.sheetWrites)} style write(s) on the sheet across ` +
            `${String(frames.raf)} frame(s) -- ${JSON.stringify(drawer)}`
        ).toBe('matrix(1, 0, 0, 1, 0, 0)')
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
