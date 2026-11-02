// Validate real frame budget against Chromium Page.startScreencast JPEGs, not an encoder model using the constant it claims to prove.
// Noise at representative phone/tablet/wide viewports reaches real BridgeHostSubscriptions at product scale/quality.
// Keep mobile-web-app- prefix: workflow selection and change-scope detector both key on it.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type CDPSession, type Page } from 'playwright-core'
import { mobileWebAppDependenciesPresent } from './mobile-web-app-bundle-dependencies.mjs'
import type { BrowserScreencastFrame } from '../../../mobile/src/transport/browser-screencast-protocol'

// Lazy-load mobile modules after dependency gate; static imports require absent Expo tsconfig before describe.skip runs in root shards. Type-only imports erase safely.
async function loadSweepModules() {
  const [request, parameters, caps, fakes, harnessModule, protocol] = await Promise.all([
    import('../../../mobile/src/browser/browser-screencast-request.web.ts'),
    import('../../../mobile/src/browser/browser-screencast-request-parameters'),
    import('../../../mobile/src/mobile-web-shell/bridge/bridge-caps'),
    import('../../../mobile/src/mobile-web-shell/bridge-host-test-fakes'),
    import('../../../mobile/src/mobile-web-shell/bridge-host-test-harness'),
    import('../../../mobile/src/transport/browser-screencast-protocol')
  ])
  return {
    budgetedMobileViewDeviceScaleFactor: request.budgetedMobileViewDeviceScaleFactor,
    WORST_CASE_JPEG_BYTES_PER_PIXEL: request.WORST_CASE_JPEG_BYTES_PER_PIXEL,
    BROWSER_FRAME_QUALITY: parameters.BROWSER_FRAME_QUALITY,
    BRIDGE_MAX_MESSAGE_BYTES: caps.BRIDGE_MAX_MESSAGE_BYTES,
    utf8ByteLength: caps.utf8ByteLength,
    clientFrame: fakes.clientFrame,
    harness: harnessModule.harness,
    ID: harnessModule.ID,
    BrowserScreencastOpcode: protocol.BrowserScreencastOpcode
  }
}

let loaded: Awaited<ReturnType<typeof loadSweepModules>> | null = null

function sweep() {
  if (loaded === null) {
    throw new Error('the sweep modules are not loaded')
  }
  return loaded
}

type Viewport = { width: number; height: number }

// Sample aspect ratios and budget pressure without replaying one encoder contract 111 times.
const VIEWPORTS: Viewport[] = [
  { width: 320, height: 480 },
  { width: 360, height: 640 },
  { width: 390, height: 712 },
  { width: 393, height: 720 },
  { width: 430, height: 932 },
  { width: 600, height: 800 },
  { width: 768, height: 1024 },
  { width: 1024, height: 768 },
  { width: 320, height: 1600 },
  { width: 1400, height: 480 },
  { width: 834, height: 896 },
  { width: 1280, height: 640 }
]

let browser: Browser | null = null
let page: Page | null = null
let cdp: CDPSession | null = null

// Share bundling gate to distinguish browser-capable mobile job from root shards; required-env check makes a broken mobile install fail instead of skip.
const describeSweep = mobileWebAppDependenciesPresent() ? describe : describe.skip

// Noise floor distinguishes full-resolution pixels from viewport-averaged noise (<0.3 B/px).
// Chromium/Chrome measured minima 0.544/0.481 B/px; use 0.4, since 0.5 falsely failed valid runner encodes.
const NOISE_FLOOR_BYTES_PER_PIXEL = 0.4

beforeAll(async () => {
  if (!mobileWebAppDependenciesPresent()) {
    return
  }
  loaded = await loadSweepModules()
  const executablePath = process.env.ORCA_MOBILE_WEB_RENDER_BROWSER
  browser = await chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {})
  })
  const context = await browser.newContext()
  page = await context.newPage()
  cdp = await context.newCDPSession(page)
  await page.setContent(noiseDocument({ viewportMeta: true }))
}, 120_000)

afterAll(async () => {
  await browser?.close()
})

// Viewport-meta removal is the guard/control arm; it averages away canvas noise.
function noiseDocument({ viewportMeta }: { viewportMeta: boolean }): string {
  const meta = viewportMeta
    ? '<meta name="viewport" content="width=device-width, initial-scale=1">'
    : ''
  const style =
    '<style>html,body{margin:0;overflow:hidden;background:#000}canvas{display:block}</style>'
  return `<!doctype html><html><head>${meta}${style}</head><body><canvas id="noise"></canvas></body></html>`
}

/** One screencast frame: its encoded size, and when the browser captured it. */
type CapturedFrame = { bytes: number; stamp: number | null }

// Admit only post-raster arrivals captured at/after paintedAt (page’s second rAF clock); arrival order does not preserve capture order.
// Under 20× throttling, stale black/previous-viewport frames arrived after barrier but were stamped 86–161ms before paint, falsely understating budget cost.
function framesCarryingTheNoise(
  frames: CapturedFrame[],
  rastered: number,
  paintedAt: number
): CapturedFrame[] {
  return frames.slice(rastered).filter((one) => one.stamp !== null && one.stamp >= paintedAt)
}

// Capture noise with product screencast quality; read quality from source (90 would exceed cap at every budgeted viewport).
// Headless CDP composites at DIP surface size despite deviceScaleFactor (identical ratios at 1×/3×); request one device pixel per CSS pixel.
// Viewport meta prevents 980px-default layout averaging; floor/control assertions prove full-resolution noise reaches encoder.
async function screencastNoiseJpegBytes(
  frame: { width: number; height: number },
  seed: number,
  target: { page: Page; cdp: CDPSession } | null = null
): Promise<number> {
  const resolved = target ?? (page !== null && cdp !== null ? { page, cdp } : null)
  if (resolved === null) {
    throw new Error('the sweep has no page')
  }
  const session = resolved.cdp
  const sheet = resolved.page
  await session.send('Emulation.setDeviceMetricsOverride', {
    width: frame.width,
    height: frame.height,
    deviceScaleFactor: 1,
    mobile: true
  })
  await sheet.evaluate(({ width, height }) => {
    const canvas = document.getElementById('noise')
    if (!(canvas instanceof HTMLCanvasElement)) {
      throw new Error('no noise canvas')
    }
    canvas.width = width
    canvas.height = height
    canvas.style.width = `${width}px`
    canvas.style.height = `${height}px`
  }, frame)

  const frames: CapturedFrame[] = []
  const onFrame = (event: {
    data: string
    sessionId: number
    metadata: { timestamp?: number }
  }): void => {
    frames.push({
      bytes: Buffer.from(event.data, 'base64').length,
      // Seconds in the protocol, milliseconds here, so it compares against the page's own clock.
      stamp: event.metadata.timestamp === undefined ? null : event.metadata.timestamp * 1000
    })
    void session.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => {})
  }
  session.on('Page.screencastFrame', onFrame)
  let rastered = 0
  let paintedAt = Number.POSITIVE_INFINITY
  try {
    await session.send('Page.startScreencast', {
      format: 'jpeg',
      quality: sweep().BROWSER_FRAME_QUALITY,
      maxWidth: frame.width,
      maxHeight: frame.height,
      everyNthFrame: 1
    })
    // Paint over same CDP session after screencast starts; two rAFs commit content and return page clock to identify matching captures.
    const painting = await session.send('Runtime.evaluate', {
      awaitPromise: true,
      returnByValue: true,
      expression: `(async () => {
        const canvas = document.getElementById('noise')
        const context = canvas.getContext('2d')
        const image = context.createImageData(canvas.width, canvas.height)
        let state = ${seed >>> 0}
        for (let index = 0; index < image.data.length; index += 4) {
          state = (Math.imul(state, 1664525) + 1013904223) >>> 0
          image.data[index] = (state >>> 24) & 0xff
          image.data[index + 1] = (state >>> 16) & 0xff
          image.data[index + 2] = (state >>> 8) & 0xff
          image.data[index + 3] = 255
        }
        context.putImageData(image, 0, 0)
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
        return Date.now()
      })()`
    })
    paintedAt = Number(painting.result.value)

    // Commit is not raster: CPU-starved resize produced 87/444 partial post-commit frames below noise floor, falsely fitting cap.
    // captureScreenshot waits for current compositor raster; discard quality-0 bytes, using completion as barrier (~17ms).
    await session.send('Page.captureScreenshot', { format: 'jpeg', quality: 0 })
    rastered = frames.length

    // Wait for two browser-stamped post-paint frames and take larger to reject partial raster; ignore stale previous-viewport arrivals.
    const deadline = Date.now() + 20_000
    for (
      let nudge = 0;
      framesCarryingTheNoise(frames, rastered, paintedAt).length < 2 && Date.now() < deadline;
      nudge += 1
    ) {
      await session.send('Runtime.evaluate', {
        expression: `document.documentElement.style.background = ${nudge % 2 === 0 ? "'#000'" : "'#111'"}`
      })
      await sheet.waitForTimeout(80)
    }
  } finally {
    await session.send('Page.stopScreencast').catch(() => {})
    session.off('Page.screencastFrame', onFrame)
  }
  const afterPaint = framesCarryingTheNoise(frames, rastered, paintedAt)
  if (afterPaint.length === 0) {
    // Never fall back to pre-raster frames; print capture offset from paint so stale-only windows fail diagnostically instead of reporting a cheaper encoder.
    const seen = JSON.stringify(
      frames.map((one) => ({
        bytes: one.bytes,
        afterPaintMs: one.stamp === null ? null : Math.round(one.stamp - paintedAt)
      }))
    )
    throw new Error(
      `no screencast frame carried the rastered noise for ${frame.width}x${frame.height}: ${seen}`
    )
  }
  return Math.max(...afterPaint.map((one) => one.bytes))
}

function screencastFrame(image: Uint8Array, frame: { width: number; height: number }) {
  return {
    opcode: sweep().BrowserScreencastOpcode.Frame,
    seq: 1,
    format: 'jpeg',
    metadata: {
      offsetTop: 0,
      pageScaleFactor: 1,
      deviceWidth: frame.width,
      deviceHeight: frame.height,
      imageWidth: frame.width,
      imageHeight: frame.height,
      scrollOffsetX: 0,
      scrollOffsetY: 0,
      timestamp: 1_758_326_400.123456
    },
    image
  } satisfies BrowserScreencastFrame
}

/** What the real host does with this frame: the bytes it posted, or null when it dropped it. */
function postThroughShell(
  image: Uint8Array,
  frame: { width: number; height: number }
): number | null {
  const bridge = sweep().harness({ ready: true })
  bridge.host.receive(
    sweep().clientFrame({
      type: 'subscribe',
      id: sweep().ID,
      method: 'browser.screencast',
      params: { worktree: 'id:w', page: 'p' },
      wantsBinary: true
    })
  )
  const before = bridge.posted.length
  // Require binary subscription open or a missing lane would masquerade as budget-driven frame drop.
  const emitBinary = bridge.client.streams[0]?.emitBinary
  if (emitBinary === null || emitBinary === undefined) {
    throw new Error('the subscribe opened no binary stream')
  }
  emitBinary(screencastFrame(image, frame))
  if (bridge.posted.length === before) {
    return null
  }
  return sweep().utf8ByteLength(bridge.posted.at(-1) ?? '')
}

/** The device-pixel frame the budget asks this viewport for. */
function budgetedFrame(viewport: Viewport) {
  const scale = sweep().budgetedMobileViewDeviceScaleFactor(viewport)
  return {
    scale,
    width: Math.round(viewport.width * scale),
    height: Math.round(viewport.height * scale)
  }
}

describeSweep('the frame budget at representative viewport sizes', () => {
  it('keeps representative budgeted viewports inside one bridge message', async () => {
    const overCap: string[] = []
    let worstBytesPerPixel = 0
    let bestBytesPerPixel = 1
    for (const viewport of VIEWPORTS) {
      const frame = budgetedFrame(viewport)
      const imageBytes = await screencastNoiseJpegBytes(
        frame,
        viewport.width * 7_919 + viewport.height
      )
      const bytesPerPixel = imageBytes / (frame.width * frame.height)
      worstBytesPerPixel = Math.max(worstBytesPerPixel, bytesPerPixel)
      bestBytesPerPixel = Math.min(bestBytesPerPixel, bytesPerPixel)
      const posted = postThroughShell(new Uint8Array(imageBytes), frame)
      if (posted === null || posted > sweep().BRIDGE_MAX_MESSAGE_BYTES) {
        overCap.push(
          `${viewport.width}x${viewport.height} at scale ${frame.scale}: ${String(posted)}`
        )
      }
    }

    console.log(
      `[frame-budget-sweep] screencast bytes per pixel: max ${worstBytesPerPixel.toFixed(5)}, ` +
        `min ${bestBytesPerPixel.toFixed(5)}`
    )
    expect(overCap).toEqual([])
    // Compare measured cost with production constant; historical encoder ratios consume margin without necessarily violating budget.
    expect(worstBytesPerPixel).toBeLessThanOrEqual(sweep().WORST_CASE_JPEG_BYTES_PER_PIXEL)
    // Assert noise floor too or an encoder silently measuring empty images appears comfortably within budget.
    expect(bestBytesPerPixel).toBeGreaterThan(NOISE_FLOOR_BYTES_PER_PIXEL)
  }, 300_000)

  it('does not budget below one device pixel per CSS pixel, and the shell drops what will not fit', async () => {
    const frame = budgetedFrame({ width: 1400, height: 1600 })
    expect(frame.scale).toBe(1)
    const imageBytes = await screencastNoiseJpegBytes(frame, 1)
    expect(postThroughShell(new Uint8Array(imageBytes), frame)).toBeNull()
  }, 120_000)

  it('reads far under the floor without the viewport meta, which is what the floor guards', async () => {
    if (browser === null) {
      throw new Error('the sweep has no browser')
    }
    // Remove viewport meta as control: 980px default layout scales/averages noise, falsely passing upper-bound-only checks.
    const frame = { width: 768, height: 1133 }
    const context = await browser.newContext()
    try {
      const bare = await context.newPage()
      const session = await context.newCDPSession(bare)
      await bare.setContent(noiseDocument({ viewportMeta: false }))
      const bytes = await screencastNoiseJpegBytes(frame, 4_242, { page: bare, cdp: session })
      const bytesPerPixel = bytes / (frame.width * frame.height)

      expect(bytesPerPixel).toBeLessThan(0.3)
      // And the floor the sweep asserts is above it, so that assertion is what fails first.
      expect(bytesPerPixel).toBeLessThan(NOISE_FLOOR_BYTES_PER_PIXEL)
    } finally {
      await context.close()
    }
  }, 120_000)
})
