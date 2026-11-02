import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium } from 'playwright-core'
import { buildMobileWebAppBundle } from '../../build-mobile-web-app-bundle.mjs'
import { mobileWebAppDependenciesPresent } from '../mobile-web-app-bundle-dependencies.mjs'
import {
  createBundleServer,
  installShellDouble,
  readBridgeFaultGrant,
  readBridgeProtocolVersion,
  readShellCsp
} from './mobile-web-app-render-harness.mjs'
import { MOBILE_WEB_PAGE_ROUTES } from '../../mobile-web-page-routes.mjs'

// viewBox only: browsers size this 300 x 60 unless the viewer reads the drawing's own extent.
const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 240"><rect width="1200" height="240" fill="#2563eb"/><circle cx="600" cy="120" r="80" fill="#facc15"/></svg>'
const host = { id: 'svg-host', name: 'SVG Host', endpoint: 'ws://svg-test', lastConnected: 1 }
const pattern = '/h/[hostId]/files/preview/[worktreeId]'
const pathname = '/h/svg-host/files/preview/folder-project'
const bundles = mobileWebAppDependenciesPresent()
const shots = process.env.ORCA_MOBILE_SVG_SHOTS_DIR
let scratch, server, origin, browser, policy, version, faultGrant
beforeAll(async () => {
  if (!bundles) {
    return
  }
  scratch = await mkdtemp(join(tmpdir(), 'orca-mobile-svg-render-'))
  const built = await buildMobileWebAppBundle({ outDir: join(scratch, 'bundle') })
  policy = await readShellCsp()
  version = await readBridgeProtocolVersion()
  faultGrant = await readBridgeFaultGrant()
  const served = await createBundleServer({ outDir: built.outDir, cspHeader: () => policy })
  server = served.server
  origin = served.origin
  const executablePath = process.env.ORCA_MOBILE_WEB_RENDER_BROWSER
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) })
  if (shots) {
    await mkdir(shots, { recursive: true })
  }
}, 120_000)
afterAll(async () => {
  await browser?.close()
  await new Promise((resolve) => (server ? server.close(resolve) : resolve()))
  if (scratch) {
    await rm(scratch, { recursive: true, force: true })
  }
})

async function openSvg() {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true
  })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  const grants = MOBILE_WEB_PAGE_ROUTES.find((route) => route.pathname === pattern).grants
  await page.addInitScript(installShellDouble, {
    version,
    sessionId: 'svg-session',
    buildId: 'svg-build',
    route: {
      pathname,
      params: { relativePath: 'logo.svg', name: 'logo.svg', worktreeName: 'Folder project' }
    },
    host,
    storage: {},
    faultGrant,
    grants: [faultGrant, ...grants],
    pageRoutes: [pattern],
    replies: { 'files.read': { content: SVG, byteLength: SVG.length, truncated: false } }
  })
  await page.goto(`${origin}/`)
  return { context, page, errors }
}

function drawing(page) {
  return page.getByRole('img', { name: 'logo.svg drawing' })
}

async function touch(cdp, type, points) {
  await cdp.send('Input.dispatchTouchEvent', {
    type,
    touchPoints: points.map(([x, y], id) => ({ x, y, id }))
  })
}

const describeRender = bundles ? describe : describe.skip
describeRender('mobile SVG preview under the shipped shell policy', () => {
  it('draws the SVG at its own aspect, pinches and double-taps to zoom, and keeps source', async () => {
    const { context, page, errors } = await openSvg()
    const img = drawing(page)
    await page.waitForFunction(
      () => document.querySelector('img[alt="logo.svg drawing"]')?.complete
    )
    const fitted = await img.boundingBox()
    // Fit fills the phone's width, so the 5:1 drawing is upscaled past the browser's 300 px guess.
    expect(fitted.width).toBeGreaterThan(330)
    expect(fitted.width / fitted.height).toBeCloseTo(5, 1)
    expect(
      await img.evaluate((element) => element.naturalWidth > 0 && element.naturalHeight > 0)
    ).toBe(true)
    if (shots) {
      await page.screenshot({ path: join(shots, 'mobile-svg-fit.png') })
    }

    const cdp = await context.newCDPSession(page)
    const y = fitted.y + fitted.height / 2
    const x = fitted.x + fitted.width / 2
    await touch(cdp, 'touchStart', [
      [x - 40, y],
      [x + 40, y]
    ])
    for (let step = 1; step <= 5; step++) {
      await touch(cdp, 'touchMove', [
        [x - 40 - step * 20, y],
        [x + 40 + step * 20, y]
      ])
    }
    await touch(cdp, 'touchEnd', [])
    const pinched = await img.boundingBox()
    expect(pinched.width).toBeGreaterThan(fitted.width * 2)
    if (shots) {
      await page.screenshot({ path: join(shots, 'mobile-svg-pinched.png') })
    }

    await page.touchscreen.tap(x, y)
    await page.touchscreen.tap(x, y)
    await expect.poll(async () => (await img.boundingBox()).width).toBeCloseTo(fitted.width, 0)

    await page.getByRole('tab', { name: 'View SVG source' }).click()
    await page.getByText('viewBox="0 0 1200 240"', { exact: false }).waitFor()
    expect(errors).toEqual([])
    await context.close()
  }, 60_000)
})
