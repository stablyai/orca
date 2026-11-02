import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium } from 'playwright-core'
import { buildMobileWebAppBundle } from '../build-mobile-web-app-bundle.mjs'
import { mobileWebAppDependenciesPresent } from './mobile-web-app-bundle-dependencies.mjs'
import { MOBILE_WEB_APP_ROUTE_ROOT } from './mobile-web-app-route-manifest.mjs'
import { chatSelectionProbeRouteSource } from './preview/mobile-web-app-chat-selection-probe-route.mjs'
import { LAYOUT_SOURCE } from './preview/mobile-web-app-terminal-probe-route.mjs'
import {
  createBundleServer,
  installShellDouble,
  projectDir,
  readBridgeFaultGrant,
  readBridgeProtocolVersion,
  readShellCsp
} from './preview/mobile-web-app-render-harness.mjs'

const ROUTE = `/${MOBILE_WEB_APP_ROUTE_ROOT}/chat-selection-probe`
const ANDROID =
  'Mozilla/5.0 (Linux; Android 15; Pixel 8 Build/AP3A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/131.0.6778.200 Mobile Safari/537.36'
const bundles = mobileWebAppDependenciesPresent()
const describeRender = bundles ? describe : describe.skip
let browser, origin, scratch, server, bridgeVersion, faultGrant

beforeAll(async () => {
  if (!bundles) {
    return
  }
  bridgeVersion = await readBridgeProtocolVersion()
  faultGrant = await readBridgeFaultGrant()
  scratch = await mkdtemp(join(tmpdir(), 'orca-chat-selection-'))
  const appDir = join(scratch, 'app')
  const routeDir = join(appDir, MOBILE_WEB_APP_ROUTE_ROOT)
  await mkdir(routeDir, { recursive: true })
  await writeFile(join(routeDir, '_layout.tsx'), LAYOUT_SOURCE)
  const chatDir = join(projectDir, 'mobile/src/session/native-chat')
  await writeFile(
    join(routeDir, 'chat-selection-probe.tsx'),
    chatSelectionProbeRouteSource(
      join(chatDir, 'transcript'),
      join(chatDir, 'composer/MobileNativeChatComposerField')
    )
  )
  const built = await buildMobileWebAppBundle({
    appDir,
    outDir: join(scratch, 'bundle'),
    pageRoutes: [{ pathname: ROUTE, grants: ['native.clipboard.write', 'externalLink'] }]
  })
  const served = await createBundleServer({ outDir: built.outDir, cspHeader: await readShellCsp() })
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

async function openChat(userAgent = ANDROID) {
  const page = await browser.newPage({
    viewport: { width: 412, height: 915 },
    hasTouch: true,
    userAgent
  })
  await page.addInitScript(
    (platform) => {
      Object.defineProperty(navigator, 'platform', { value: platform })
    },
    userAgent.includes('Android') ? 'Linux armv8l' : 'iPhone'
  )
  await page.addInitScript(installShellDouble, {
    version: bridgeVersion,
    sessionId: 'selection-session',
    buildId: 'selection-build',
    route: { pathname: ROUTE, params: {} },
    host: {
      id: 'selection-host',
      name: 'Selection host',
      endpoint: 'ws://selection',
      lastConnected: 1
    },
    storage: {},
    faultGrant,
    grants: [faultGrant, 'native.clipboard.write', 'externalLink'],
    pageRoutes: [ROUTE],
    replies: { 'native.clipboard.write': { written: true } }
  })
  await page.goto(origin)
  await page.waitForFunction(
    () => globalThis.__orcaChatSelection || globalThis.__orcaRenderCheckFaults.length
  )
  expect(await page.evaluate(() => globalThis.__orcaRenderCheckFaults)).toEqual([])
  await page.getByText('Android selection probe.', { exact: true }).scrollIntoViewIfNeeded()
  return page
}

async function textPoint(target) {
  await target.scrollIntoViewIfNeeded()
  return target.evaluate((node) => {
    const range = document.createRange()
    range.selectNodeContents(node)
    const box = range.getClientRects()[0]
    return { x: box.x + 5, y: box.y + box.height / 2 }
  })
}

// A held touch exercises the real responder; Chromium does not supply Android's native selection toolbar.
async function longPress(page, target) {
  const point = await textPoint(target)
  const input = await page.context().newCDPSession(page)
  try {
    await input.send('Input.synthesizeTapGesture', {
      ...point,
      duration: 700,
      gestureSourceType: 'touch'
    })
  } finally {
    await input.detach()
  }
}

describeRender('Android chat selection in the hosted page', () => {
  it('opens message actions and requests native copy of the complete message', async () => {
    const page = await openChat()
    try {
      await longPress(page, page.getByText('Android selection probe.', { exact: true }))
      const copy = page.getByText('Copy message', { exact: true })
      await copy.waitFor({ timeout: 5000 })
      await copy.tap()
      await expect
        .poll(() =>
          page.evaluate(() =>
            globalThis.__orcaRenderCheckRequests.filter(
              (request) => request.method === 'native.clipboard.write'
            )
          )
        )
        .toEqual([
          {
            method: 'native.clipboard.write',
            params: {
              mime: 'text',
              value: await page.evaluate(() => globalThis.__orcaChatSelection.content)
            }
          }
        ])
    } finally {
      await page.close()
    }
  }, 30_000)

  it('selects a stable message snapshot and pastes the copied range into the composer', async () => {
    const page = await openChat()
    try {
      const content = await page.evaluate(() => globalThis.__orcaChatSelection.content)
      await longPress(page, page.getByText('Android selection probe.', { exact: true }))
      await page.getByText('Select text', { exact: true }).tap()
      const selectedMessage = page.getByText(content, { exact: true })
      await selectedMessage.waitFor()
      const point = await textPoint(selectedMessage)
      await page.mouse.dblclick(point.x, point.y)
      expect(await page.evaluate(() => window.getSelection().toString())).toBe('Android')
      await page.evaluate(() => globalThis.__orcaChatSelection.update())
      expect(await selectedMessage.textContent()).toBe(content)
      expect(await page.evaluate(() => window.getSelection().toString())).toBe('Android')
      const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
      await page.keyboard.press(`${modifier}+c`)
      await page.getByRole('button', { name: 'Close', exact: true }).tap()
      const composer = page.getByRole('textbox', { name: 'Message', exact: true })
      await composer.click()
      await page.keyboard.press(`${modifier}+v`)
      expect(await composer.inputValue()).toBe('Android')
    } finally {
      await page.close()
    }
  }, 30_000)

  it.each(['the guide', 'src/main.ts'])(
    'opens selection actions when holding %s without opening the target',
    async (label) => {
      const page = await openChat()
      try {
        await longPress(page, page.getByText(label, { exact: true }))
        await page.getByText('Select text', { exact: true }).waitFor({ timeout: 5000 })
        expect(await page.evaluate(() => globalThis.__orcaChatOpenedFile ?? null)).toBe(null)
        expect(
          await page.evaluate(() =>
            globalThis.__orcaRenderCheckNotifies.filter((frame) => frame.name === 'externalLink')
          )
        ).toEqual([])
      } finally {
        await page.close()
      }
    },
    30_000
  )

  it('keeps short link taps working', async () => {
    const page = await openChat()
    try {
      await page.getByText('src/main.ts', { exact: true }).tap()
      expect(await page.evaluate(() => globalThis.__orcaChatOpenedFile)).toBe('src/main.ts')
      await page.getByText('the guide', { exact: true }).tap()
      expect(
        await page.evaluate(() =>
          globalThis.__orcaRenderCheckNotifies.filter((frame) => frame.name === 'externalLink')
        )
      ).toEqual([
        expect.objectContaining({ name: 'externalLink', url: 'https://example.com/guide' })
      ])
      expect(await page.getByText('Select text', { exact: true }).count()).toBe(0)
    } finally {
      await page.close()
    }
  }, 30_000)

  it('scrolls through text without opening message actions or selecting words', async () => {
    const page = await openChat()
    try {
      const scroll = page.getByTestId('chat-scroll')
      const before = await scroll.evaluate((node) => node.scrollTop)
      const point = await textPoint(page.getByText('Scrollable paragraph 2.', { exact: true }))
      const input = await page.context().newCDPSession(page)
      await input.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] })
      for (let step = 1; step <= 8; step++) {
        await input.send('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: [{ x: point.x, y: point.y - step * 15 }]
        })
      }
      await input.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      await input.detach()
      await expect.poll(() => scroll.evaluate((node) => node.scrollTop)).toBeGreaterThan(before)
      expect(await page.getByText('Select text', { exact: true }).count()).toBe(0)
      expect(await page.evaluate(() => window.getSelection().toString())).toBe('')
    } finally {
      await page.close()
    }
  }, 30_000)

  it('preserves inline selection on non-Android pages', async () => {
    const page = await openChat(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148'
    )
    try {
      const target = page.getByText('Android selection probe.', { exact: true })
      const point = await textPoint(target)
      await page.mouse.dblclick(point.x, point.y)
      expect(await page.evaluate(() => window.getSelection().toString())).toBe('Android')
      expect(await page.getByText('Select text', { exact: true }).count()).toBe(0)
    } finally {
      await page.close()
    }
  }, 30_000)
})
