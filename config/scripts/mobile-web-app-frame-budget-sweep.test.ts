/**
 * The mobile-view frame budget, held against Chromium's own JPEG encoder across the viewport range.
 *
 * `WORST_CASE_JPEG_BYTES_PER_PIXEL` is the one number the budget cannot derive, and every other
 * check of it is circular: a case that encodes `noise(area * theConstant)` is measuring a byte
 * count the constant just produced, so it agrees with the constant whatever the constant says. This
 * encodes a real noise JPEG per viewport, at the scale the real budget picks, and posts it through
 * the real `BridgeHostSubscriptions`. It is the only thing here that can falsify the number.
 *
 * Chromium rather than a Node encoder, because the frames are CDP screencast frames: the bytes the
 * budget has to survive are the ones Chromium produces, not the ones another library would.
 *
 * In `config/scripts` rather than the mobile suite for that reason — this is where a browser is
 * available — and it drives the mobile modules directly, so the budget, the scale and the host are
 * all the real ones.
 *
 * Named into the `mobile-web-app-` family so two things hold without anyone remembering them: the
 * `mobile_web_app` job's filter picks it up, and `pr-code-change-scope.mjs` fires that job when
 * this file changes. Both key off that prefix.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type Page } from 'playwright-core'
import { mobileWebAppDependenciesPresent } from './mobile-web-app-bundle-dependencies.mjs'
import type { BrowserScreencastFrame } from '../../mobile/src/transport/browser-screencast-protocol'

/**
 * The mobile modules load lazily, after the dependency check, never at the top of the file: vite
 * transforms anything under `mobile/` against `mobile/tsconfig.json`, which extends
 * `expo/tsconfig.base.json`, so a static import fails at load in the sharded `test` job before
 * `describe.skip` gets a say. Type-only imports are erased and stay static.
 */
async function loadSweepModules() {
  const [request, parameters, caps, fakes, harnessModule, protocol] = await Promise.all([
    import('../../mobile/src/browser/browser-screencast-request.web'),
    import('../../mobile/src/browser/browser-screencast-request-parameters'),
    import('../../mobile/src/mobile-web-shell/bridge/bridge-caps'),
    import('../../mobile/src/mobile-web-shell/bridge-host-test-fakes'),
    import('../../mobile/src/mobile-web-shell/bridge-host-test-harness'),
    import('../../mobile/src/transport/browser-screencast-protocol')
  ])
  return {
    budgetedMobileViewDeviceScaleFactor: request.budgetedMobileViewDeviceScaleFactor,
    mobileBrowserFrameAreaBudget: request.mobileBrowserFrameAreaBudget,
    WORST_CASE_JPEG_BYTES_PER_PIXEL: request.WORST_CASE_JPEG_BYTES_PER_PIXEL,
    MOBILE_VIEW_DEVICE_SCALE_FACTOR: parameters.MOBILE_VIEW_DEVICE_SCALE_FACTOR,
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

/** The viewport range the pane is mounted in, phone through tablet, in CSS pixels. */
const VIEWPORT_WIDTHS = [320, 360, 390, 393, 412, 430, 480, 600, 768, 834, 1024, 1280, 1400]
const VIEWPORT_HEIGHTS = [480, 640, 712, 720, 800, 896, 932, 1024, 1180, 1366, 1600]

type Viewport = { width: number; height: number }

const VIEWPORTS: Viewport[] = VIEWPORT_WIDTHS.flatMap((width) =>
  VIEWPORT_HEIGHTS.map((height) => ({ width, height }))
)

let browser: Browser | null = null
let page: Page | null = null

/**
 * Skipped where the bundling tests skip, which is the sharded `test` job.
 *
 * Not because this needs react-native-web — it does not — but because that job has no browser to
 * launch, and this is the flag that tells the two jobs apart. In the `mobile_web_app` job the
 * required-env check turns a missing install into a failure, so it cannot skip there silently.
 */
const describeSweep = mobileWebAppDependenciesPresent() ? describe : describe.skip

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
  page = await (await browser.newContext()).newPage()
  await page.goto('about:blank')
}, 120_000)

afterAll(async () => {
  await browser?.close()
})

/**
 * A noise JPEG at the quality the pane ships, encoded by Chromium, returned as the base64 the
 * bridge carries. The quality is read, not retyped: at 90 every budgeted viewport posts over the cap.
 */
async function encodeNoiseJpeg(size: { width: number; height: number }, seed: number) {
  if (page === null) {
    throw new Error('the sweep has no page')
  }
  const quality = sweep().BROWSER_FRAME_QUALITY / 100
  return await page.evaluate(
    ({ width, height, seed, quality }) => {
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const context = canvas.getContext('2d')
      if (context === null) {
        throw new Error('no 2d context')
      }
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
      return canvas.toDataURL('image/jpeg', quality).split(',')[1] ?? ''
    },
    { ...size, seed, quality }
  )
}

/** Base64 back to the byte length it stands for, which is what the shell is handed. */
function base64ByteLength(b64: string): number {
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0
  return (b64.length / 4) * 3 - padding
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
  // Same reason as the sibling pin: a subscribe that opened no binary lane would read here as a
  // dropped frame, and this sweep's whole verdict is which frames were dropped.
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

/**
 * The viewports the budget can actually fit, which are the ones it makes a promise about.
 *
 * Below a scale of one the module stops: asking for fewer device pixels than CSS pixels is a
 * blurry frame rather than a working one, so a viewport too large for the cap keeps scale 1 and
 * the frame that does not fit is C6 ruling 1's to drop. Split here so the promise and the
 * exception are both asserted rather than averaged.
 */
const withinBudget = (viewport: Viewport) => budgetedFrame(viewport).scale > 1

describeSweep('the frame budget across the viewport range', () => {
  it('keeps every viewport it budgets for inside one bridge message', async () => {
    const overCap: string[] = []
    let worstBytesPerPixel = 0
    let bestBytesPerPixel = 1
    for (const viewport of VIEWPORTS.filter(withinBudget)) {
      const frame = budgetedFrame(viewport)
      const b64 = await encodeNoiseJpeg(frame, viewport.width * 7_919 + viewport.height)
      const imageBytes = base64ByteLength(b64)
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

    expect(overCap).toEqual([])
    // And the constant is above every cost that sweep just measured. Against the constant, not the
    // 0.55351 measured on 2026-09-20 that its docstring records: the margin above that is what an
    // encoder drift may spend, and a drift inside it is not a budget failure. Without this the
    // assertion above passes by the budget being merely generous.
    expect(worstBytesPerPixel).toBeLessThanOrEqual(sweep().WORST_CASE_JPEG_BYTES_PER_PIXEL)
    // The low end too, so a sweep that silently stopped encoding real images is visible: every
    // frame here is noise, and noise never compresses to a tenth of a byte per pixel.
    expect(bestBytesPerPixel).toBeGreaterThan(0.5)
  }, 300_000)

  it('does not budget below one device pixel per CSS pixel, and the shell drops what will not fit', async () => {
    // The exception the split above names. These are real: a 1400x1180 viewport posts 1.2 MB.
    const tooLarge = VIEWPORTS.filter((viewport) => !withinBudget(viewport))
    // The 32 of the 143 the budget leaves at scale 1, a fixed number because the set is fixed.
    expect(tooLarge.length).toBe(32)

    const largest = tooLarge.reduce((left, right) =>
      left.width * left.height > right.width * right.height ? left : right
    )
    const frame = budgetedFrame(largest)
    expect(frame.scale).toBe(1)
    const b64 = await encodeNoiseJpeg(frame, 1)
    expect(postThroughShell(new Uint8Array(base64ByteLength(b64)), frame)).toBeNull()
  }, 120_000)

  it('never asks for more density than native, anywhere in the range', () => {
    for (const viewport of VIEWPORTS) {
      expect(budgetedFrame(viewport).scale).toBeLessThanOrEqual(
        sweep().MOBILE_VIEW_DEVICE_SCALE_FACTOR
      )
    }
  })

  it('sweeps a range wide enough to contain the phones the pane runs on', () => {
    // The set is fixed, so this is what says it still covers the case the old constant missed.
    expect(VIEWPORTS).toContainEqual({ width: 390, height: 712 })
    expect(VIEWPORTS).toContainEqual({ width: 393, height: 720 })
    expect(VIEWPORTS).toContainEqual({ width: 360, height: 640 })
    expect(VIEWPORTS.length).toBe(143)
    expect(sweep().mobileBrowserFrameAreaBudget()).toBeGreaterThan(0)
  })
})
