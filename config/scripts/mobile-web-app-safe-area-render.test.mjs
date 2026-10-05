import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium } from 'playwright-core'
import { buildMobileWebAppBundle } from './build-mobile-web-app-bundle.mjs'
import { mobileWebAppDependenciesPresent } from './mobile-web-app-bundle-dependencies.mjs'
import {
  createBundleServer,
  installShellDouble,
  readBridgeFaultGrant,
  readBridgeProtocolVersion,
  readShellCsp
} from './mobile-web-app-render-harness.mjs'

// The page lays out edge-to-edge under the shell's system bars and pads through its own
// SafeAreaViews, by the insets `init` carries. Measured in a real browser because what is under
// test is which providers and navigators expo-router actually mounts above a screen.
const HOST_ROUTE = '/h/render-check-host'
const HOST = {
  id: 'render-check-host',
  name: 'Render Check Host',
  endpoint: 'ws://render-check',
  lastConnected: 1
}
const INSETS = { top: 40, right: 0, bottom: 30, left: 0 }
/** What the browser's own `env(safe-area-inset-*)` reads, which is what DefaultNavigator pads by.
 *  Different from INSETS so a padding taken from it cannot pass for the shell's. */
const ENV_INSETS = { top: 17, right: 0, bottom: 11, left: 0 }

const bundles = mobileWebAppDependenciesPresent()
const describeRender = bundles ? describe : describe.skip

let scratch
let server
let browser
let origin
let bridgeVersion
let faultGrant

beforeAll(async () => {
  bridgeVersion = await readBridgeProtocolVersion()
  faultGrant = await readBridgeFaultGrant()
  if (!bundles) {
    return
  }
  scratch = await mkdtemp(join(tmpdir(), 'orca-mobile-web-app-safe-area-'))
  const { outDir } = await buildMobileWebAppBundle({ outDir: join(scratch, 'bundle') })
  const served = await createBundleServer({ outDir, cspHeader: await readShellCsp() })
  server = served.server
  origin = served.origin
  const executablePath = process.env.ORCA_MOBILE_WEB_RENDER_BROWSER
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) })
}, 180_000)

afterAll(async () => {
  await browser?.close()
  server?.close()
  if (scratch) {
    await rm(scratch, { recursive: true, force: true })
  }
})

/** The host route's header text top and its bottom control's bottom, as the page laid them out. */
async function openHostRoute(safeAreaInsets, envInsets = ENV_INSETS) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
  const errors = []
  page.on('pageerror', (error) => errors.push(`${error.name}: ${error.message}`))
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: envInsets })
  await page.addInitScript(installShellDouble, {
    version: bridgeVersion,
    sessionId: 'safe-area-session',
    buildId: 'safe-area-build',
    route: { pathname: HOST_ROUTE },
    host: HOST,
    storage: {},
    faultGrant,
    grants: [faultGrant],
    safeAreaInsets
  })
  await page.goto(`${origin}/`, { waitUntil: 'load' })
  await page.waitForFunction((name) => document.body.innerText.includes(name), HOST.name, {
    timeout: 30_000,
    polling: 250
  })
  return { page, errors }
}

function readEdges(page) {
  return page.evaluate((name) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    let title = null
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      if (node.textContent === name) {
        title = node
        break
      }
    }
    const range = document.createRange()
    if (title !== null) {
      range.selectNodeContents(title)
    }
    const fab = [...document.querySelectorAll('[role="button"]')].find(
      (element) => element.getAttribute('aria-label') === 'New workspace'
    )
    return {
      titleTop: title === null ? null : range.getBoundingClientRect().top,
      fabBottom: fab?.getBoundingClientRect().bottom ?? null,
      envTop: (() => {
        const probe = document.createElement('div')
        probe.style.paddingTop = 'env(safe-area-inset-top)'
        document.body.append(probe)
        const top = getComputedStyle(probe).paddingTop
        probe.remove()
        return top
      })(),
      viewportHeight: window.innerHeight
    }
  }, HOST.name)
}

describeRender('the page pads for the system bars once, by the shell insets', () => {
  it('moves the header by exactly the inset init carried, not by the browser env', async () => {
    const bare = await openHostRoute(null)
    const zero = await readEdges(bare.page)
    await bare.page.close()
    const inset = await openHostRoute(INSETS)
    const padded = await readEdges(inset.page)
    await inset.page.close()
    const noEnv = await openHostRoute(null, { top: 0, right: 0, bottom: 0, left: 0 })
    const envless = await readEdges(noEnv.page)
    await noEnv.page.close()
    expect([...bare.errors, ...inset.errors, ...noEnv.errors]).toEqual([])
    expect(zero.titleTop).not.toBeNull()
    // The override is live, so a padding read from the browser would show up below.
    expect([zero.envTop, envless.envTop]).toEqual([`${ENV_INSETS.top}px`, '0px'])
    // Nothing above the screens pads by the browser's own measurement.
    expect(zero.titleTop).toBe(envless.titleTop)
    // One pad, the shell's: DefaultNavigator would add ENV_INSETS.top on top of it, and a screen
    // reading the web provider's own measurement would pad by ENV_INSETS.top instead.
    expect(padded.titleTop - zero.titleTop).toBe(INSETS.top)
  }, 90_000)

  it('follows a re-sent init, which is how the keyboard and rotation reach the page', async () => {
    const opened = await openHostRoute(INSETS)
    const before = await readEdges(opened.page)
    await opened.page.evaluate(
      (insets) => {
        globalThis.__orcaRenderCheckResendInit({ safeAreaInsets: insets })
      },
      { ...INSETS, top: 64 }
    )
    await opened.page.waitForFunction(
      ({ name, top }) => {
        const found = [...document.querySelectorAll('div')].some(
          (element) => element.textContent === name && element.getBoundingClientRect().top > top
        )
        return found
      },
      { name: HOST.name, top: before.titleTop + 10 },
      { timeout: 10_000, polling: 100 }
    )
    const after = await readEdges(opened.page)
    await opened.page.close()
    expect(opened.errors).toEqual([])
    expect(after.titleTop - before.titleTop).toBe(64 - INSETS.top)
  }, 60_000)
})
