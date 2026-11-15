import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, webkit } from 'playwright-core'
import { buildMobileWebAppBundle } from '../../build/mobile-web-app/build-mobile-web-app-bundle.mjs'
import { mobileWebAppDependenciesPresent } from '../mobile-web-app-bundle-dependencies.mjs'
import {
  createBundleServer,
  installShellDouble,
  readBridgeBackNames,
  readBridgeFaultGrant,
  readBridgeProtocolVersion,
  readShellCsp
} from '../preview/mobile-web-app-render-harness.mjs'

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

/** The bottom bar's Workspace options button, by its own label. */
function workspaceOptionsButton(page) {
  return page.getByRole('button', { name: 'Workspace options', exact: true })
}

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
