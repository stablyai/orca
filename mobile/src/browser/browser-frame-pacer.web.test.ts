// @vitest-environment happy-dom
/**
 * The frame pacer as the page resolves it: against the `.web.ts` paint siblings, with real DOM
 * nodes for the layers, so what is asserted is what a layer shows and whether it is visible.
 */
import { act } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Image, ImageLoadEvent, View } from 'react-native'
import {
  BrowserScreencastOpcode,
  type BrowserScreencastFrame
} from '../transport/browser-screencast-protocol'
import { createBrowserFramePacer } from './browser-frame-pacer'
import { createBrowserFrameDataUri } from './browser-frame-data-uri'
import { MOBILE_BROWSER_FRAME_MIN_INTERVAL_MS } from './browser-screencast-request'

// Both siblings, so what runs below is the module graph the page bundle resolves.
vi.mock('./browser-frame-layer-paint', async () => await import('./browser-frame-layer-paint.web'))
vi.mock('./browser-frame-data-uri', async () => await import('./browser-frame-data-uri.web'))

/** One frame per index, with base64 that names it, so a layer's background says what landed. */
function frameAt(index: number): BrowserScreencastFrame {
  return {
    opcode: BrowserScreencastOpcode.Frame,
    seq: index,
    format: 'jpeg',
    metadata: { deviceWidth: 390, deviceHeight: 712, pageScaleFactor: 1 },
    image: new Uint8Array([index]),
    b64: `frame-${index}`
  }
}

/**
 * Decodes the test finishes one at a time, keyed on the source they were given: happy-dom resolves
 * every `decode()` in the next microtask, which would hide a frame sitting undecoded on a layer.
 */
type PendingDecode = { uri: string; settle: (decoded: boolean) => void }
const decodes: { pending: PendingDecode[] } = { pending: [] }
let realImage: typeof window.Image

beforeEach(() => {
  vi.useFakeTimers()
  decodes.pending = []
  realImage = window.Image
  window.Image = class extends realImage {
    override decode(): Promise<void> {
      const uri = this.src
      return new Promise<void>((resolve, reject) => {
        decodes.pending.push({
          uri,
          settle: (decoded) => (decoded ? resolve() : reject(new Error('undecodable')))
        })
      })
    }
  }
})

afterEach(() => {
  window.Image = realImage
  vi.useRealTimers()
})

async function settleDecode(frameName: string, decoded: boolean): Promise<void> {
  const index = decodes.pending.findIndex((decode) => decode.uri.includes(frameName))
  if (index === -1) {
    throw new Error(`no decode is pending for ${frameName}`)
  }
  const [pending] = decodes.pending.splice(index, 1)
  await act(async () => {
    pending?.settle(decoded)
    await Promise.resolve()
  })
}

async function finishDecodes(): Promise<void> {
  const settling = decodes.pending
  decodes.pending = []
  await act(async () => {
    for (const decode of settling) {
      decode.settle(true)
    }
    await Promise.resolve()
  })
}

function mountImageHost(): HTMLElement {
  const host = document.createElement('div')
  host.append(document.createElement('div'))
  document.body.append(host)
  return host
}

function mountPacer() {
  const imageHosts = [mountImageHost(), mountImageHost()] as const
  const layerViews = [document.createElement('div'), document.createElement('div')] as const
  const frameUriWrites: (string | null)[] = []
  /** Every frame the pacer reported on screen, by seq. */
  const shownSeqs: number[] = []
  const pacer = createBrowserFramePacer({
    initialUri: null,
    setFrameUri: (uri) => {
      frameUriWrites.push(uri)
    },
    onShown: ({ frame }) => {
      shownSeqs.push(frame.seq)
    }
  })
  for (const layer of [0, 1] as const) {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: on RN Web a ref is the DOM node, which is what the `.web.ts` writers take; the binding's signature is still the native one.
    pacer.layers[layer].attachView(layerViews[layer] as unknown as View)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: same mismatch, for the image host the source writer takes.
    pacer.layers[layer].attachImage(imageHosts[layer] as unknown as Image)
  }
  const background = (layer: 0 | 1): string => {
    const surface = imageHosts[layer].firstElementChild
    return surface instanceof HTMLElement ? surface.style.backgroundImage : ''
  }
  /** The frame on screen: the background of the one layer that is visible. */
  const shown = (): string => {
    const visible = ([0, 1] as const).filter((layer) => layerViews[layer].style.opacity !== '0')
    expect(visible).toHaveLength(1)
    const [layer] = visible
    return layer === undefined ? '' : background(layer)
  }
  /** Delivers a frame one pacer interval after the last, so pacing is not what is measured. */
  const push = async (index: number): Promise<void> => {
    await act(async () => {
      vi.advanceTimersByTime(MOBILE_BROWSER_FRAME_MIN_INTERVAL_MS)
      pacer.push(frameAt(index), 'wt:page:mobile')
      await Promise.resolve()
    })
  }
  const advance = async (ms: number): Promise<void> => {
    await act(async () => {
      vi.advanceTimersByTime(ms)
      await Promise.resolve()
    })
  }
  return { advance, background, frameUriWrites, pacer, push, shown, shownSeqs }
}

describe('the browser frame pacer', () => {
  it('paints the first frame on both layers and shows it without a flip', async () => {
    const pane = mountPacer()

    await pane.push(1)

    expect(pane.shown()).toContain('frame-1')
    expect(pane.background(1)).toContain('frame-1')
    expect(pane.frameUriWrites).toHaveLength(1)
    expect(pane.shownSeqs).toEqual([1])
  })

  it('decodes the next frame offscreen and shows it only once it has decoded', async () => {
    const pane = mountPacer()
    await pane.push(1)
    await finishDecodes()

    await pane.push(2)
    expect(pane.background(1)).toContain('frame-2')
    expect(pane.shown()).toContain('frame-1')
    expect(pane.shownSeqs).toEqual([1])

    await finishDecodes()
    expect(pane.shown()).toContain('frame-2')
    expect(pane.shownSeqs).toEqual([1, 2])
  })

  it('keeps flipping frame after frame, reporting each once and publishing one source', async () => {
    const pane = mountPacer()
    for (let index = 1; index <= 10; index += 1) {
      await pane.push(index)
      await finishDecodes()
      expect(pane.shown()).toContain(`frame-${index}`)
    }
    expect(pane.shownSeqs).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(pane.frameUriWrites).toHaveLength(1)
  })

  it('paints at most one frame per interval', async () => {
    const pane = mountPacer()
    await pane.push(1)
    await finishDecodes()
    await pane.push(2)
    await finishDecodes()

    pane.pacer.push(frameAt(3), 'wt:page:mobile')
    expect(pane.background(0)).toContain('frame-1')

    await pane.advance(MOBILE_BROWSER_FRAME_MIN_INTERVAL_MS)
    expect(pane.background(0)).toContain('frame-3')
  })

  it('never re-points a decoding layer, and shows the newest frame once it settles', async () => {
    const pane = mountPacer()
    await pane.push(1)
    await finishDecodes()
    await pane.push(2)
    await pane.push(3)
    await pane.push(4)

    await pane.advance(10_000)
    expect(pane.background(1)).toContain('frame-2')

    await settleDecode('frame-2', true)
    expect(pane.shown()).toContain('frame-2')
    await pane.advance(MOBILE_BROWSER_FRAME_MIN_INTERVAL_MS)
    expect(pane.background(0)).toContain('frame-4')
    await settleDecode('frame-4', true)
    expect(pane.shown()).toContain('frame-4')
  })

  it('shows a slow last frame when nothing newer waits', async () => {
    const pane = mountPacer()
    await pane.push(1)
    await finishDecodes()
    await pane.push(2)

    await pane.advance(10_000)
    await settleDecode('frame-2', true)

    expect(pane.shown()).toContain('frame-2')
  })

  it('flips straight to a layer that already holds the frame, which reloads nothing', async () => {
    const pane = mountPacer()
    await pane.push(1)
    await finishDecodes()
    await pane.push(2)
    await finishDecodes()

    // Layer 0 still holds frame 1, as a blinking caret sends it back.
    await pane.push(1)

    expect(pane.shown()).toContain('frame-1')
    expect(decodes.pending).toEqual([])
  })

  it('skips a frame sent again after it failed to decode, and keeps streaming', async () => {
    const pane = mountPacer()
    await pane.push(1)
    await finishDecodes()
    await pane.push(2)
    await settleDecode('frame-2', false)

    await pane.push(2)
    expect(pane.shown()).toContain('frame-1')
    expect(decodes.pending).toEqual([])

    await pane.push(3)
    await finishDecodes()
    expect(pane.shown()).toContain('frame-3')
  })

  it('hands the layer of an undecodable frame to the newest waiting frame', async () => {
    const pane = mountPacer()
    await pane.push(1)
    await finishDecodes()
    await pane.push(2)
    await pane.push(3)

    await settleDecode('frame-2', false)
    expect(pane.shown()).toContain('frame-1')

    await settleDecode('frame-3', true)
    expect(pane.shown()).toContain('frame-3')
  })

  it('settles a layer on a native load only for the source it holds', async () => {
    const pane = mountPacer()
    await pane.push(1)
    await finishDecodes()
    await pane.push(2)
    const nativeLoad = (index: number): ImageLoadEvent =>
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the pacer reads only nativeEvent.source.uri.
      ({
        nativeEvent: { source: { uri: createBrowserFrameDataUri(frameAt(index)) } }
      }) as ImageLoadEvent

    await pane.push(3)
    pane.pacer.layers[1].onLoad(nativeLoad(1))
    await pane.advance(MOBILE_BROWSER_FRAME_MIN_INTERVAL_MS)
    expect(pane.shown()).toContain('frame-1')
    expect(pane.background(1)).toContain('frame-2')

    pane.pacer.layers[1].onLoad(nativeLoad(2))
    expect(pane.shown()).toContain('frame-2')
  })

  it('keeps streaming after a layer remounts its Image', async () => {
    const pane = mountPacer()
    await pane.push(1)
    await finishDecodes()

    pane.pacer.layers[1].attachImage(null)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: on RN Web a ref is the DOM node the writers take.
    pane.pacer.layers[1].attachImage(mountImageHost() as unknown as Image)
    await finishDecodes()
    await pane.push(2)
    await finishDecodes()

    expect(pane.shownSeqs).toEqual([1, 2])
  })

  it('does not flip a decode that settles after a reset, but flips to it when it is sent again', async () => {
    const pane = mountPacer()
    await pane.push(1)
    await finishDecodes()
    await pane.push(2)

    pane.pacer.reset()
    await settleDecode('frame-2', true)
    expect(pane.shown()).toContain('frame-1')

    await pane.push(2)
    expect(pane.shown()).toContain('frame-2')
  })

  it('holds a frame sent again after a reset until the earlier decode of it settles', async () => {
    const pane = mountPacer()
    await pane.push(1)
    await finishDecodes()
    await pane.push(2)

    pane.pacer.reset()
    await pane.push(2)
    expect(pane.shown()).toContain('frame-1')

    await settleDecode('frame-2', true)
    expect(pane.shown()).toContain('frame-2')
  })
})
