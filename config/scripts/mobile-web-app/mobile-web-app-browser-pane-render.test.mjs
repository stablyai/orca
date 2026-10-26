// Exercise entire browser-frame bridge: base64 encode/decode, web layer paint and native-equivalent decode-before-flip.
// Bundle a scratch single-route tree without registering production route (C6 ruling 4).
// JPEG noise resists compression, making over-cap frames realistic rather than artificially inflated.
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium } from 'playwright-core'
import { buildMobileWebAppBundle } from '../build-mobile-web-app-bundle.mjs'
import { MOBILE_WEB_APP_ROUTE_ROOT } from './mobile-web-app-route-manifest.mjs'
import { mobileWebAppDependenciesPresent } from './mobile-web-app-bundle-dependencies.mjs'
import {
  createBundleServer,
  installShellDouble,
  readBridgeFaultGrant,
  readBridgeProtocolVersion,
  readBridgeWindowCaps,
  readBrowserFrameQuality,
  readShellCsp
} from './preview/mobile-web-app-render-harness.mjs'

const mobileDir = fileURLToPath(new URL('../../../mobile', import.meta.url))

const HOST_ID = 'render-check-host'
const ROUTE = { pathname: '/h' }
const SHELL_HOST = {
  id: HOST_ID,
  name: 'Render Check Host',
  endpoint: 'ws://render-check',
  lastConnected: 1
}
const VIEWPORT = { width: 390, height: 844 }
/** The grant C6.1 named for the binary lane, and the one the negative case withholds. */
const BINARY_GRANT = 'screencastBinary'
const SCREENCAST = 'browser.screencast'

/** The frame's source viewport, which is what a tap is mapped back into. */
const SOURCE = { deviceWidth: 390, deviceHeight: 712 }

// Use pane-requested web viewport 390×698; noisy native 780×1424 is 811,168 base64 chars (124% cap), reserved for rejection case.
const FRAME = { width: 390, height: 698 }
// Without viewport meta, Chromium lays out at 980 CSS px and scales to phone width; input expects CSS pixels, not source-device pixels.
// Chromium 1217 measurement (2026-09-20) exposed ~41% targeting; viewport-meta control has scale one.
const NO_VIEWPORT_META_PAGE_SCALE = SOURCE.deviceWidth / 980
/** Noise at the largest layout the clamps admit, measured at 3,761,580 characters: 574% of the cap. */
const OVER_CAP_FRAME = { width: 2400, height: 2160 }

// Scratch pane-only route uses fixed-depth relative imports for reproducibility; substitute desktop screencastSupported answer, leaving capability probe to C7.
const ROUTE_SOURCE = `
import { useHostClient } from '../../../src/transport/host-client-hooks'
import { MobileBrowserPane } from '../../../src/browser/MobileBrowserPane'

const TAB = {
  type: 'browser',
  id: 'render-check-tab',
  title: 'Render check',
  browserWorkspaceId: 'render-check-workspace',
  browserPageId: 'render-check-page',
  url: 'https://example.test/',
  loading: false,
  canGoBack: false,
  canGoForward: false,
  isActive: true
}

export default function BrowserPaneRenderCheckRoute() {
  const { client } = useHostClient('${HOST_ID}')
  return (
    <MobileBrowserPane
      client={client}
      worktreeId="render-check-worktree"
      tab={TAB}
      screencastSupported={true}
      keyboardLift={0}
      bottomInset={0}
      onToast={() => {}}
    />
  )
}
`

const bundles = mobileWebAppDependenciesPresent()
const describePane = bundles ? describe : describe.skip

let scratch = null
let server = null
let origin = null
let browser = null
let cspHeader = null
let bridgeVersion = null
let faultGrant = null
let windowCaps = null

beforeAll(async () => {
  if (!bundles) {
    return
  }
  cspHeader = await readShellCsp()
  bridgeVersion = await readBridgeProtocolVersion()
  faultGrant = await readBridgeFaultGrant()
  windowCaps = await readBridgeWindowCaps()
  // Keep scratch inside mobile/ so esbuild’s upward bare-import resolution finds react-native and pane deps.
  await mkdir(join(mobileDir, '.tmp'), { recursive: true })
  scratch = await mkdtemp(join(mobileDir, '.tmp', 'browser-pane-render-'))
  const routeDir = join(scratch, MOBILE_WEB_APP_ROUTE_ROOT)
  await mkdir(routeDir, { recursive: true })
  await writeFile(join(routeDir, 'index.tsx'), ROUTE_SOURCE)
  const { outDir } = await buildMobileWebAppBundle({
    appDir: scratch,
    outDir: join(scratch, 'bundle'),
    pageRoutes: [{ pathname: ROUTE.pathname, grants: [BINARY_GRANT] }]
  })
  const served = await createBundleServer({ outDir, cspHeader })
  server = served.server
  origin = served.origin
  const executablePath = process.env.ORCA_MOBILE_WEB_RENDER_BROWSER
  browser = await chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {})
  })
}, 300_000)

afterAll(async () => {
  await browser?.close()
  server?.close()
  if (scratch) {
    // Remove this run’s scratch only; sibling suites share mobile/.tmp.
    await rm(scratch, { recursive: true, force: true })
  }
})

/** One page with the shell double installed, its console and its requests watched. */
async function openPane({ grants }) {
  const context = await browser.newContext({ viewport: VIEWPORT })
  const page = await context.newPage()
  const consoleErrors = []
  const foreignRequests = []
  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text())
    }
  })
  page.on('pageerror', (error) => consoleErrors.push(error.message))
  page.on('request', (request) => {
    if (!request.url().startsWith(origin) && !request.url().startsWith('data:')) {
      foreignRequests.push(request.url())
    }
  })
  await page.addInitScript(installShellDouble, {
    version: bridgeVersion,
    sessionId: 'render-check-session',
    buildId: 'render-check-build-id',
    route: ROUTE,
    host: SHELL_HOST,
    storage: {},
    faultGrant,
    grants,
    pageRoutes: [ROUTE.pathname],
    replies: { 'browser.mouseClick': { ok: true } },
    streams: [SCREENCAST],
    windowCaps
  })
  // The page reports a CSP violation as a document event; the header is the shell's own.
  await page.addInitScript(() => {
    globalThis.__orcaRenderCheckCsp = []
    document.addEventListener('securitypolicyviolation', (event) => {
      globalThis.__orcaRenderCheckCsp.push({
        directive: event.violatedDirective,
        blockedUri: event.blockedURI
      })
    })
  })
  await page.goto(`${origin}${ROUTE.pathname}`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => document.querySelector('#root')?.childElementCount > 0)
  return {
    page,
    context,
    consoleErrors,
    foreignRequests,
    csp: () => page.evaluate(() => globalThis.__orcaRenderCheckCsp)
  }
}

/** A JPEG of deterministic noise, encoded in the page, returned as the base64 the bridge carries. */
async function encodeNoiseJpeg(page, { width, height, seed }) {
  const quality = await readBrowserFrameQuality()
  return page.evaluate(
    ({ width, height, seed, quality }) => {
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const context = canvas.getContext('2d')
      const image = context.createImageData(width, height)
      let state = seed >>> 0
      for (let index = 0; index < image.data.length; index += 4) {
        state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0
        image.data[index] = (state >>> 24) & 0xff
        image.data[index + 1] = (state >>> 16) & 0xff
        image.data[index + 2] = (state >>> 8) & 0xff
        image.data[index + 3] = 255
      }
      context.putImageData(image, 0, 0)
      return canvas.toDataURL('image/jpeg', quality).split(',')[1]
    },
    { width, height, seed, quality }
  )
}

/** Hand the page one frame, and say what the double did with it. */
function emitFrame(page, { b64, frameSeq, width, height, pageScaleFactor = 1 }) {
  return page.evaluate(
    ({ b64, frameSeq, width, height, pageScaleFactor, source }) => {
      const subscription = globalThis.__orcaRenderCheckSubscribes.at(-1)
      if (!subscription) {
        return 'no-subscription'
      }
      return globalThis.__orcaRenderCheckEmitBinary(subscription.id, {
        b64,
        format: 'jpeg',
        frameSeq,
        metadata: {
          offsetTop: 0,
          pageScaleFactor,
          deviceWidth: source.deviceWidth,
          deviceHeight: source.deviceHeight,
          imageWidth: width,
          imageHeight: height,
          scrollOffsetX: 0,
          scrollOffsetY: 0,
          timestamp: 1_758_326_400.123456
        }
      })
    },
    { b64, frameSeq, width, height, pageScaleFactor, source: SOURCE }
  )
}

// Select RN-Web background-image, the actual browser-frame-layer-paint write; testID could name an unpainted element.
function readPaintedLayers(page) {
  return page.evaluate(() => {
    const painted = [...document.querySelectorAll('*')].filter((element) =>
      element.style?.backgroundImage?.startsWith('url("data:image/jpeg')
    )
    return painted.map((element) => {
      // The layer whose opacity the flip writes is the `<View>` above the `<Image>` surface.
      let layer = element.parentElement
      while (layer && layer.style.opacity === '') {
        layer = layer.parentElement
      }
      return {
        uri: element.style.backgroundImage,
        digest: element.style.backgroundImage.slice(-24),
        opacity: layer?.style.opacity ?? null
      }
    })
  })
}

const waitForPaint = (page, count) =>
  page.waitForFunction(
    (expected) =>
      [...document.querySelectorAll('*')].filter((element) =>
        element.style?.backgroundImage?.startsWith('url("data:image/jpeg')
      ).length >= expected,
    count,
    { timeout: 15_000 }
  )

/** Which of the pane's two layers is on screen, by its position among them. */
async function visibleLayerIndex(page) {
  const layers = await readPaintedLayers(page)
  return layers.findIndex((layer) => layer.opacity === '1')
}

// Wait for exact visible layer: URI writes precede decode/opacity flip (observed 80.7ms vs 85.7ms), so digest changes can return early.
// Exact layer assertion also rejects a pane with nothing visible.
async function waitForLayerFlip(page, staleIndex) {
  await expect
    .poll(() => visibleLayerIndex(page), { timeout: 15_000, interval: 25 })
    .toBe(1 - staleIndex)
}

describePane('the browser pane in a page', () => {
  it('subscribes over the binary lane and paints the frame it is handed', async () => {
    const view = await openPane({ grants: [faultGrant, BINARY_GRANT] })
    try {
      await view.page.waitForFunction(() => globalThis.__orcaRenderCheckSubscribes.length > 0)
      const subscribes = await view.page.evaluate(() => globalThis.__orcaRenderCheckSubscribes)
      expect(subscribes).toHaveLength(1)
      expect(subscribes[0]).toMatchObject({ method: SCREENCAST, wantsBinary: true })

      const b64 = await encodeNoiseJpeg(view.page, { ...FRAME, seed: 1 })
      expect(await emitFrame(view.page, { b64, frameSeq: 1, ...FRAME })).toBe('posted')
      await waitForPaint(view.page, 1)

      const layers = await readPaintedLayers(view.page)
      // First frame paints both layers with initial layer 0 visible; only next frame proves decode-then-flip.
      expect(layers.length).toBeGreaterThan(0)
      expect(layers.filter((layer) => layer.opacity === '1').map((layer) => layer.uri)).toEqual([
        `url("data:image/jpeg;base64,${b64}")`
      ])
      expect(view.consoleErrors).toEqual([])
      expect(await view.csp()).toEqual([])
      expect(view.foreignRequests).toEqual([])
    } finally {
      await view.context.close()
    }
  }, 120_000)

  it('flips the double buffer on the second frame', async () => {
    const view = await openPane({ grants: [faultGrant, BINARY_GRANT] })
    try {
      await view.page.waitForFunction(() => globalThis.__orcaRenderCheckSubscribes.length > 0)
      const first = await encodeNoiseJpeg(view.page, { ...FRAME, seed: 7 })
      await emitFrame(view.page, { b64: first, frameSeq: 1, ...FRAME })
      await waitForPaint(view.page, 1)
      const before = await readPaintedLayers(view.page)
      const staleIndex = before.findIndex((layer) => layer.opacity === '1')

      const second = await encodeNoiseJpeg(view.page, { ...FRAME, seed: 99 })
      expect(second).not.toBe(first)
      await emitFrame(view.page, { b64: second, frameSeq: 2, ...FRAME })
      await waitForLayerFlip(view.page, staleIndex)

      const after = await readPaintedLayers(view.page)
      const visible = after.filter((layer) => layer.opacity === '1')
      expect(visible).toHaveLength(1)
      expect(visible[0].digest).not.toBe(before.find((l) => l.opacity === '1')?.digest)
      expect(view.consoleErrors).toEqual([])
      expect(await view.csp()).toEqual([])
    } finally {
      await view.context.close()
    }
  }, 120_000)

  it('drops an over-cap frame, keeps the stream, and paints the next one', async () => {
    const view = await openPane({ grants: [faultGrant, BINARY_GRANT] })
    try {
      await view.page.waitForFunction(() => globalThis.__orcaRenderCheckSubscribes.length > 0)
      const small = await encodeNoiseJpeg(view.page, { ...FRAME, seed: 3 })
      await emitFrame(view.page, { b64: small, frameSeq: 1, ...FRAME })
      await waitForPaint(view.page, 1)
      const before = await readPaintedLayers(view.page)
      const staleIndex = before.findIndex((layer) => layer.opacity === '1')

      // Noise at the largest layout the clamps admit, which §1 measured at 574% of the cap.
      const huge = await encodeNoiseJpeg(view.page, { ...OVER_CAP_FRAME, seed: 5 })
      expect(huge.length).toBeGreaterThan(windowCaps.maxMessageBytes)
      expect(await emitFrame(view.page, { b64: huge, frameSeq: 2, ...OVER_CAP_FRAME })).toBe(
        'dropped'
      )

      // The stream is still open: the next frame arrives on the same subscription and paints.
      const next = await encodeNoiseJpeg(view.page, { ...FRAME, seed: 11 })
      expect(await emitFrame(view.page, { b64: next, frameSeq: 3, ...FRAME })).toBe('posted')
      await waitForLayerFlip(view.page, staleIndex)

      expect(await view.page.evaluate(() => globalThis.__orcaRenderCheckDroppedFrames)).toEqual([2])
      expect(await view.page.evaluate(() => globalThis.__orcaRenderCheckSubscribes.length)).toBe(1)
      expect(await view.csp()).toEqual([])
      expect(view.consoleErrors).toEqual([])
    } finally {
      await view.context.close()
    }
  }, 120_000)

  it('asks for no binary lane at all when the shell withholds the grant', async () => {
    const view = await openPane({ grants: [faultGrant] })
    try {
      await view.page.waitForFunction(() =>
        document.body.innerText.includes('Update the Orca app to stream browser tabs here.')
      )
      expect(await view.page.evaluate(() => globalThis.__orcaRenderCheckSubscribes)).toEqual([])
      expect(view.consoleErrors).toEqual([])
      expect(await view.csp()).toEqual([])
      expect(view.foreignRequests).toEqual([])
    } finally {
      await view.context.close()
    }
  }, 120_000)

  it('streams past the unacked window because the page acks, and drops nothing', async () => {
    // Thirty ~200KB frames exceed 4MiB window but each fits message cap; missing/ignored acks must cause drops.
    const view = await openPane({ grants: [faultGrant, BINARY_GRANT] })
    try {
      await view.page.waitForFunction(() => globalThis.__orcaRenderCheckSubscribes.length > 0)
      const b64 = await encodeNoiseJpeg(view.page, { ...FRAME, seed: 55 })
      const cumulative = b64.length * 30
      expect(cumulative).toBeGreaterThan(windowCaps.maxUnackedBytes)

      const outcomes = []
      for (let frameSeq = 1; frameSeq <= 30; frameSeq += 1) {
        outcomes.push(await emitFrame(view.page, { b64, frameSeq, ...FRAME }))
      }

      expect(new Set(outcomes)).toEqual(new Set(['posted']))
      expect(await view.page.evaluate(() => globalThis.__orcaRenderCheckDroppedFrames)).toEqual([])
      // And the acks are real rather than the window merely being generous.
      const acks = await view.page.evaluate(() => globalThis.__orcaRenderCheckAcks)
      expect(acks.length).toBeGreaterThan(0)
      expect(await view.csp()).toEqual([])
      expect(view.consoleErrors).toEqual([])
    } finally {
      await view.context.close()
    }
  }, 120_000)

  it('issues one mouseClick with the geometry the native pane would send', async () => {
    const view = await openPane({ grants: [faultGrant, BINARY_GRANT] })
    try {
      await view.page.waitForFunction(() => globalThis.__orcaRenderCheckSubscribes.length > 0)
      const b64 = await encodeNoiseJpeg(view.page, { ...FRAME, seed: 21 })
      await emitFrame(view.page, { b64, frameSeq: 1, ...FRAME })
      await waitForPaint(view.page, 1)

      // Frame centre maps exactly to source viewport centre regardless of letterboxing.
      const box = await view.page.evaluate(() => {
        const painted = [...document.querySelectorAll('*')].find((element) =>
          element.style?.backgroundImage?.startsWith('url("data:image/jpeg')
        )
        const rect = painted.getBoundingClientRect()
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
      })
      await view.page.mouse.click(box.x, box.y)
      await view.page.waitForFunction(() => globalThis.__orcaRenderCheckRequests.length > 0)

      const requests = await view.page.evaluate(() => globalThis.__orcaRenderCheckRequests)
      // One request proves double’s click reply prevented move/down/up fallback (four requests).
      expect(requests).toHaveLength(1)
      expect(requests[0].method).toBe('browser.mouseClick')
      expect(requests[0].params).toMatchObject({
        worktree: 'id:render-check-worktree',
        page: 'render-check-page',
        button: 'left',
        modifiers: []
      })
      // Allow one source-device pixel: fractional 382.33 CSS px width for 390 source px offsets centre; larger error means scale/axis/letterbox bug.
      expect(Math.abs(requests[0].params.x - SOURCE.deviceWidth / 2)).toBeLessThanOrEqual(1)
      expect(Math.abs(requests[0].params.y - SOURCE.deviceHeight / 2)).toBeLessThanOrEqual(1)
      expect(await view.csp()).toEqual([])
      expect(view.consoleErrors).toEqual([])
    } finally {
      await view.context.close()
    }
  }, 120_000)
  it('maps a tap through the page scale the frame was painted at', async () => {
    const view = await openPane({ grants: [faultGrant, BINARY_GRANT] })
    try {
      await view.page.waitForFunction(() => globalThis.__orcaRenderCheckSubscribes.length > 0)
      const b64 = await encodeNoiseJpeg(view.page, { ...FRAME, seed: 22 })
      await emitFrame(view.page, {
        b64,
        frameSeq: 1,
        ...FRAME,
        pageScaleFactor: NO_VIEWPORT_META_PAGE_SCALE
      })
      await waitForPaint(view.page, 1)

      const box = await view.page.evaluate(() => {
        const painted = [...document.querySelectorAll('*')].find((element) =>
          element.style?.backgroundImage?.startsWith('url("data:image/jpeg')
        )
        const rect = painted.getBoundingClientRect()
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
      })
      await view.page.mouse.click(box.x, box.y)
      await view.page.waitForFunction(() => globalThis.__orcaRenderCheckRequests.length > 0)

      const requests = await view.page.evaluate(() => globalThis.__orcaRenderCheckRequests)
      expect(requests[0].method).toBe('browser.mouseClick')
      // Scaled 980 CSS px layout maps from 712-device-px frame height; allow three CSS px since one device pixel is 2.5 CSS px plus fractional width.
      expect(Math.abs(requests[0].params.x - 980 / 2)).toBeLessThanOrEqual(3)
      expect(
        Math.abs(requests[0].params.y - SOURCE.deviceHeight / 2 / NO_VIEWPORT_META_PAGE_SCALE)
      ).toBeLessThanOrEqual(3)
      // Unmapped, this is what the device proof recorded: the frame's own device space, on BODY.
      expect(requests[0].params.x).not.toBe(Math.round(SOURCE.deviceWidth / 2))
      expect(await view.csp()).toEqual([])
      expect(view.consoleErrors).toEqual([])
    } finally {
      await view.context.close()
    }
  }, 120_000)
})
