import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, webkit } from 'playwright-core'
import { buildMobileWebAppBundle } from '../build-mobile-web-app-bundle.mjs'
import { mobileWebAppDependenciesPresent } from './mobile-web-app-bundle-dependencies.mjs'
import {
  createBundleServer,
  installShellDouble,
  readBridgeBackNames,
  readBridgeFaultGrant,
  readBridgeProtocolVersion,
  readShellCsp
} from './preview/mobile-web-app-render-harness.mjs'

const HOST_ROUTE = '/h/render-check-host'
const SHELL_HOST = {
  id: 'render-check-host',
  name: 'Render Check Host',
  endpoint: 'ws://render-check',
  lastConnected: 1
}

const VIEWPORT = { width: 390, height: 844 }

// Without a dependency array, esbuild’s untransformed useAnimatedStyle has no Babel-written __closure, so Reanimated mapper runs only once.
// Both Chromium/WebKit must move; one-engine coverage could falsely support an engine-specific explanation.
const ENGINES = [
  {
    name: 'chromium',
    // Use runner Chrome override to avoid CI browser downloads.
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
let backNames = null

beforeAll(async () => {
  if (!bundles) {
    return
  }
  cspHeader = await readShellCsp()
  bridgeVersion = await readBridgeProtocolVersion()
  faultGrant = await readBridgeFaultGrant()
  backNames = await readBridgeBackNames()
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

// Select data-testid from RN testID; corner-radius selection coupled sheet identity to styling and misreported design changes.
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

// Install counters at document start: __raf counts requested frames, __sheetWrites counts Reanimated style writes over whole page lifetime.
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

/** The bottom bar's Workspace options button, by its own label. */
function workspaceOptionsButton(page) {
  return page.getByRole('button', { name: 'Workspace options', exact: true })
}

describeDrawer('the bottom drawer on the page', () => {
  for (const engine of ENGINES) {
    it(`slides the sheet onto the screen in ${engine.name}`, async () => {
      const browser = await engine.launch()
      try {
        // Force motion before navigation: reduced motion completes in one frame and hides an unsubscribed mapper.
        // Reanimated latches media query at import; emulateMedia after goto cannot undo it.
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
          undefined,
          { timeout: 30_000, polling: 250 }
        )
        // Use header’s Workspace options sheet; same drawer implementation without row-layout prerequisites.
        const button = workspaceOptionsButton(page)
        // Wait for actionability before resetting counters; CI WebKit dropped clicks sent as soon as the label existed.
        await button.click({ trial: true, timeout: 30_000 })
        // Reset counters at click so boot work cannot count as enter-animation activity.
        await page.evaluate(() => {
          globalThis.__rafAtClick = globalThis.__raf
          globalThis.__sheetWrites = 0
        })
        await button.click({ timeout: 10_000 })
        const opened = await page
          .waitForFunction(
            () => {
              const handle = document.querySelector('[aria-label="Dismiss drawer"]')
              return handle ? true : null
            },
            undefined,
            { timeout: 10_000, polling: 100 }
          )
          .then(() => true)
          .catch(() => false)
        expect(opened, errors.join(' | ')).toBe(true)

        // Wait for actual animation progress, not a fixed delay that labels a loaded healthy runner as parked; retain diagnostics on timeout.
        await page
          .waitForFunction(
            () => {
              const sheet = document.querySelector('[data-testid="bottom-drawer-sheet"]')
              return sheet && getComputedStyle(sheet).transform === 'matrix(1, 0, 0, 1, 0, 0)'
                ? true
                : null
            },
            undefined,
            { timeout: 15_000, polling: 50 }
          )
          .catch(() => null)
        const drawer = await page.evaluate(readDrawer)
        expect(drawer.sheet, JSON.stringify(drawer)).toBe(true)

        // Require rAF activity to distinguish unsubscribed mapper from an engine that never animated.
        // Style-write counts cannot distinguish: CPU-starved healthy timing can reach final state in one write, just like broken/non-animating cases.
        const frames = await page.evaluate(() => ({
          raf: globalThis.__raf - globalThis.__rafAtClick,
          sheetWrites: globalThis.__sheetWrites
        }))
        expect(
          frames.raf,
          `${engine.name}: the page was given no animation frames after the sheet opened, so ` +
            'the enter animation never ran and the transform proves nothing about the mapper'
        ).toBeGreaterThan(0)

        // Completed mapper removes initial viewport-height translateY; first-frame-only mapper leaves a large offset.
        expect(
          drawer.transform,
          `${engine.name}: ${String(frames.sheetWrites)} style write(s) on the sheet across ` +
            `${String(frames.raf)} frame(s) -- ${JSON.stringify(drawer)}`
        ).toBe('matrix(1, 0, 0, 1, 0, 0)')
        // Verify visible bottom anchoring, the user-facing failure of a parked sheet.
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

/** Every notify the page posted, by name, so a case can say what crossed and what did not. */
function notifyNames() {
  return globalThis.__orcaRenderCheckNotifies.map((frame) => frame.name)
}

// Chromium matches Android WebView’s hardware Back; prove mounted page claims key over real bridge and closes animated sheet. WebKit has no hardware Back.
describeDrawer('the device Back key reaching a sheet on the page', () => {
  it('closes the sheet instead of leaving the screen', async () => {
    const browser = await ENGINES[0].launch()
    try {
      const page = await browser.newPage({ viewport: VIEWPORT, reducedMotion: 'no-preference' })
      const errors = []
      page.on('pageerror', (error) => errors.push(`${error.name}: ${error.message}`))
      await page.addInitScript(installShellDouble, {
        version: bridgeVersion,
        sessionId: 'render-check-session',
        buildId: 'render-check-build',
        route: { pathname: HOST_ROUTE },
        host: SHELL_HOST,
        storage: {},
        faultGrant,
        backFrame: backNames.frame
      })
      await page.goto(`${origin}/`, { waitUntil: 'load' })
      await page.waitForFunction(
        () => document.documentElement.dataset.orcaWebEntry === 'mounted',
        undefined,
        { timeout: 30_000, polling: 250 }
      )
      // Closed sheet claims nothing; shell retains its existing pop fallback.
      expect(await page.evaluate(notifyNames)).not.toContain(backNames.claim)

      await workspaceOptionsButton(page).click({ timeout: 30_000 })
      await page.waitForFunction(
        () => document.querySelector('[aria-label="Dismiss drawer"]') !== null,
        undefined,
        { timeout: 10_000, polling: 100 }
      )
      const claimed = await page.waitForFunction(
        (name) =>
          globalThis.__orcaRenderCheckNotifies.find(
            (frame) => frame.name === name && frame.claimed === true
          ) ?? null,
        backNames.claim,
        { timeout: 10_000, polling: 100 }
      )
      expect(await claimed.jsonValue(), errors.join(' | ')).toMatchObject({ claimed: true })

      await page.evaluate(() => {
        globalThis.__orcaRenderCheckSendBack()
      })
      const closed = await page
        .waitForFunction(
          () => document.querySelector('[aria-label="Dismiss drawer"]') === null,
          undefined,
          { timeout: 10_000, polling: 100 }
        )
        .then(() => true)
        .catch(() => false)
      expect(
        closed,
        `${errors.join(' | ')} | ${JSON.stringify(await page.evaluate(notifyNames))}`
      ).toBe(true)

      // Consumed Back must not ask shell to pop session route as well as close sheet.
      expect(await page.evaluate(notifyNames)).not.toContain(backNames.navigateBack)
      // And the key goes back to the shell with the sheet, so the next press leaves the screen.
      const claims = await page.evaluate(
        (name) =>
          globalThis.__orcaRenderCheckNotifies
            .filter((frame) => frame.name === name)
            .map((frame) => frame.claimed),
        backNames.claim
      )
      expect(claims).toEqual([true, false])
      expect(errors).toEqual([])
      await page.close()
    } finally {
      await browser.close()
    }
  }, 120_000)
})
