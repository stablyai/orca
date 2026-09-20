/**
 * The browser pane, mounted in a real page and painted with a real frame.
 *
 * Every other C6 check reads one half: the shell suites drive `BridgeHostSubscriptions` with no
 * page, the page suites drive the hooks with no shell, and the parity pin certifies the input
 * path from a recording. This is the only place the whole frame path runs — the encoder's base64
 * crossing the bridge, the page's decoder rebuilding the frame, the `.web.ts` layer writes
 * painting it, and the decode-then-flip that native gets for free from `Image.onLoad`.
 *
 * C6 ruling 4: no route is added for it. `bundleMobileWebApp` already takes an `appDir`, so the
 * check builds a one-route tree of its own, mounts the pane in it, and nothing under `mobile/app`
 * moves or is registered.
 *
 * The frames are JPEGs the page encodes from a noise canvas, for the reason the budget uses noise:
 * it is the image JPEG compresses least, so the over-cap case is over the cap for the reason a
 * real page would be rather than because the check inflated one.
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium } from 'playwright-core'
import { buildMobileWebAppBundle } from './build-mobile-web-app-bundle.mjs'
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
} from './mobile-web-app-render-harness.mjs'

const mobileDir = fileURLToPath(new URL('../../mobile', import.meta.url))

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

/**
 * The frame the pane asks this viewport for, read off its own subscribe: `maxWidth` 390 by
 * `maxHeight` 698 in web view mode.
 *
 * Not the phone's mobile-mode frame, which is 780x1424 and, as noise, encodes to 811,168 base64
 * characters — 124% of the cap, which is the measurement the area budget exists for. That one is
 * the over-cap case below rather than the frame that paints.
 */
const FRAME = { width: 390, height: 698 }
/** Noise at the largest layout the clamps admit, measured at 3,761,580 characters: 574% of the cap. */
const OVER_CAP_FRAME = { width: 2400, height: 2160 }

/**
 * The scratch route: the pane and nothing else.
 *
 * The imports are relative and of a fixed depth, so this source carries no path from the machine
 * that generated it. `screencastSupported` is the desktop's answer, which this route stands in for
 * because the capability probe is the session screen's to make and C7's to prove.
 */
const ROUTE_SOURCE = `
import { useHostClient } from '../../../src/transport/client-context'
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
  // Inside mobile/ rather than the system temp dir: the route resolves `react-native` and the
  // pane's own modules, and esbuild resolves a bare specifier from the importer upward.
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
    // This run's directory only. `mobile/.tmp` is a shared ignored root and another suite may be
    // holding one of its own.
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
function emitFrame(page, { b64, frameSeq, width, height }) {
  return page.evaluate(
    ({ b64, frameSeq, width, height, source }) => {
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
          pageScaleFactor: 1,
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
    { b64, frameSeq, width, height, source: SOURCE }
  )
}

/**
 * The frame on screen, read off the DOM the way RN Web paints it.
 *
 * Selected by the inline `background-image` rather than by a testID, because that write is the
 * thing under test: `browser-frame-layer-paint.web.ts` puts the data URI on the element RN Web
 * gives `<Image>` a background on, and a handle added for this check could be on an element the
 * paint never touches.
 */
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
        uri: element.style.backgroundImage.length,
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

describePane('the browser pane in a page', () => {
  /**
   * Zero, which it was not until the Zod jitless flag moved into the bundler banner.
   *
   * Zod decided whether it could compile by constructing `new Function('')`, which the shell's
   * `script-src 'self'` reports even though Zod catches the throw — once on load and again on
   * first paint. This file filtered those out by `blockedURI === 'eval'` for one round, which
   * would also have hidden a real one, so the filter is gone and the cause is fixed instead.
   */
  it('files no CSP violation at all, through load and first paint', async () => {
    const view = await openPane({ grants: [faultGrant, BINARY_GRANT] })
    try {
      await view.page.waitForFunction(() => globalThis.__orcaRenderCheckSubscribes.length > 0)
      const b64 = await encodeNoiseJpeg(view.page, { ...FRAME, seed: 33 })
      await emitFrame(view.page, { b64, frameSeq: 1, ...FRAME })
      await waitForPaint(view.page, 1)

      expect(await view.csp()).toEqual([])
      expect(view.consoleErrors).toEqual([])
    } finally {
      await view.context.close()
    }
  }, 120_000)

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
      // Both layers, because a render repaints both from `renderedFrameSource`, and one visible.
      // This does not prove the decode-then-flip ran: with the probe removed entirely, the first
      // frame still paints and a layer is still visible, because the visible layer starts at 0 and
      // never needed to move. The flip is the next case's to prove.
      expect(layers.length).toBeGreaterThan(0)
      expect(layers.filter((layer) => layer.opacity === '1')).toHaveLength(1)
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

      const second = await encodeNoiseJpeg(view.page, { ...FRAME, seed: 99 })
      expect(second).not.toBe(first)
      await emitFrame(view.page, { b64: second, frameSeq: 2, ...FRAME })
      await view.page.waitForFunction(
        (stale) =>
          [...document.querySelectorAll('*')].some(
            (element) =>
              element.style?.backgroundImage?.startsWith('url("data:image/jpeg') &&
              element.style.backgroundImage.slice(-24) !== stale
          ),
        before[0].digest,
        { timeout: 15_000 }
      )

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

      // Noise at the largest layout the clamps admit, which §1 measured at 574% of the cap.
      const huge = await encodeNoiseJpeg(view.page, { ...OVER_CAP_FRAME, seed: 5 })
      expect(huge.length).toBeGreaterThan(windowCaps.maxMessageBytes)
      expect(await emitFrame(view.page, { b64: huge, frameSeq: 2, ...OVER_CAP_FRAME })).toBe(
        'dropped'
      )

      // The stream is still open: the next frame arrives on the same subscription and paints.
      const next = await encodeNoiseJpeg(view.page, { ...FRAME, seed: 11 })
      expect(await emitFrame(view.page, { b64: next, frameSeq: 3, ...FRAME })).toBe('posted')
      await view.page.waitForFunction(
        (stale) =>
          [...document.querySelectorAll('*')].some(
            (element) =>
              element.style?.backgroundImage?.startsWith('url("data:image/jpeg') &&
              element.style.backgroundImage.slice(-24) !== stale
          ),
        before[0].digest,
        { timeout: 15_000 }
      )

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
    // The two `canCarry` arms the size check hides. Thirty frames of about 200 KB is roughly 6 MB
    // through a 4 MiB window, so a page that did not ack, or a shell double that ignored the acks
    // it sent, starts dropping partway. Nothing here is over the message cap, so a drop can only
    // come from the window.
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

      // The centre of the rendered frame, which maps back to the centre of the source viewport
      // whatever the letterboxing did, so the expectation is exact rather than approximate.
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
      // One, not four: the double replies, so the pane never takes its move/down/up fallback. With
      // the refusal the double gives every other method, this is four requests instead.
      expect(requests).toHaveLength(1)
      expect(requests[0].method).toBe('browser.mouseClick')
      expect(requests[0].params).toMatchObject({
        worktree: 'id:render-check-worktree',
        page: 'render-check-page',
        button: 'left',
        modifiers: []
      })
      // The centre of the rendered frame is the centre of the source viewport, to within the one
      // device pixel the rendered width's own fraction costs: the frame is 382.33 CSS px wide for
      // 390 source px, so the centre is not on a pixel boundary in either space. Wider than that
      // is a scale, an axis or a letterbox offset being wrong, which is what this is here for.
      expect(Math.abs(requests[0].params.x - SOURCE.deviceWidth / 2)).toBeLessThanOrEqual(1)
      expect(Math.abs(requests[0].params.y - SOURCE.deviceHeight / 2)).toBeLessThanOrEqual(1)
      expect(await view.csp()).toEqual([])
      expect(view.consoleErrors).toEqual([])
    } finally {
      await view.context.close()
    }
  }, 120_000)
})
