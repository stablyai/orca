// @vitest-environment happy-dom
import { createRequire } from 'node:module'
import { act, createElement, type ComponentType } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import type { Image, View } from 'react-native'
import {
  updateBrowserImageSource,
  updateBrowserLayerVisibility,
  whenBrowserFrameDisplayable
} from './browser-frame-layer-paint'
import {
  updateBrowserImageSource as updateBrowserImageSourceOnWeb,
  updateBrowserLayerVisibility as updateBrowserLayerVisibilityOnWeb,
  whenBrowserFrameDisplayable as whenBrowserFrameDisplayableOnWeb
} from './browser-frame-layer-paint.web'

/** A 1x1 gif, so the probe in the web sibling has something a real decoder would accept. */
const FRAME_URI = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'

/**
 * What RN Web renders an `<Image>` as: the ref is the outer element and the frame is painted as a
 * `background-image` on its first child, which is where `resizeMode` already put `background-size`.
 */
function mountImageHost(): HTMLElement {
  const host = document.createElement('div')
  host.append(document.createElement('div'))
  document.body.append(host)
  return host
}

function mountLayer(): HTMLElement {
  const layer = document.createElement('div')
  document.body.append(layer)
  return layer
}

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the point of the test is that a DOM node is what the native signature receives on RN Web, which is exactly the mismatch these siblings exist for.
const asImageRef = (node: HTMLElement) => node as unknown as Image
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: same mismatch, for the layer refs the visibility writer takes.
const asViewRef = (node: HTMLElement) => node as unknown as View

describe('the native frame-path writes against an RN Web ref', () => {
  it('throws from updateBrowserImageSource, because a DOM node has no setNativeProps', () => {
    expect(() => updateBrowserImageSource(asImageRef(mountImageHost()), FRAME_URI)).toThrow(
      /setNativeProps is not a function/
    )
  })

  it('throws from updateBrowserLayerVisibility for the same reason', () => {
    expect(() =>
      updateBrowserLayerVisibility([asViewRef(mountLayer()), asViewRef(mountLayer())], 0)
    ).toThrow(/setNativeProps is not a function/)
  })

  it('reports no decode of its own: the rendered Image fires onLoad natively', () => {
    const onDisplayable = vi.fn()
    whenBrowserFrameDisplayable(FRAME_URI, { onDisplayable, onUndecodable: vi.fn() })
    expect(onDisplayable).not.toHaveBeenCalled()
  })
})

describe('the web siblings', () => {
  it('paints the frame as a background-image on the element RN Web sizes', () => {
    const host = mountImageHost()

    updateBrowserImageSourceOnWeb(asImageRef(host), FRAME_URI)

    const surface = host.firstElementChild
    expect(surface).toBeInstanceOf(HTMLElement)
    expect(surface instanceof HTMLElement ? surface.style.backgroundImage : null).toBe(
      `url("${FRAME_URI}")`
    )
    // The host itself is untouched: RN Web's own layout styles live there.
    expect(host.style.backgroundImage).toBe('')
  })

  it('flips the double buffer with one opacity write per layer', () => {
    const layers: [HTMLElement, HTMLElement] = [mountLayer(), mountLayer()]

    updateBrowserLayerVisibilityOnWeb([asViewRef(layers[0]), asViewRef(layers[1])], 1)

    expect([layers[0].style.opacity, layers[1].style.opacity]).toEqual(['0', '1'])
  })

  it('tolerates a layer that has unmounted between the frame and the write', () => {
    expect(() => updateBrowserLayerVisibilityOnWeb([null, null], 0)).not.toThrow()
    expect(() => updateBrowserImageSourceOnWeb(null, FRAME_URI)).not.toThrow()
  })

  it('reports a frame displayable only once it has decoded', async () => {
    const onDisplayable = vi.fn()

    whenBrowserFrameDisplayableOnWeb(FRAME_URI, { onDisplayable, onUndecodable: vi.fn() })

    expect(onDisplayable).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(onDisplayable).toHaveBeenCalledTimes(1))
  })

  // happy-dom resolves `decode()` for anything, because it has no decoder; a browser rejects on a
  // corrupt frame. Stubbed rather than skipped: the rejection is the only thing that frees the
  // pending layer, and an untested one strands the pane on the frame before it for good.
  it('reports a frame that cannot decode, so the pending layer is not stranded', async () => {
    const onUndecodable = vi.fn()
    const realImage = window.Image
    class UndecodableImage extends realImage {
      override decode(): Promise<void> {
        return Promise.reject(new Error('the source image cannot be decoded'))
      }
    }
    window.Image = UndecodableImage

    try {
      whenBrowserFrameDisplayableOnWeb('data:image/jpeg;base64,notreallyjpeg', {
        onDisplayable: vi.fn(),
        onUndecodable
      })
      await vi.waitFor(() => expect(onUndecodable).toHaveBeenCalledTimes(1))
    } finally {
      window.Image = realImage
    }
  })
})

/**
 * The same write against the component it is written for, rather than against a shape this file
 * built to match it.
 *
 * `updateBrowserImageSource` paints the host's first element child because that is where RN Web
 * puts the frame today. Every other test here hands it a `div > div` of its own making, so an RN
 * Web release that reorders the host's children — it also renders an accessibility `<img>` in
 * there — would keep all of them green and paint nothing on screen. This one asks RN Web which
 * element it painted and then checks the write lands on that one.
 */
describe('against a real react-native-web Image', () => {
  /**
   * Loaded through `createRequire` rather than imported: react-native-web ships no type
   * declarations, so a bare import is an implicit `any` and drops this file out of the
   * tests-typecheck ratchet. `require` is typed as returning `any` at its own signature, so the
   * one prop this renders with can be declared here instead of asserted.
   */
  const { Image: ReactNativeWebImage }: { Image: ComponentType<{ source: { uri: string } }> } =
    createRequire(import.meta.url)('react-native-web')

  const MOUNTED_URI = 'data:image/gif;base64,bW91bnRlZA=='
  const STREAMED_URI = 'data:image/gif;base64,c3RyZWFtZWQ='

  async function renderImage(): Promise<{
    host: HTMLElement
    rerenderWith: (uri: string) => Promise<void>
    unmount: () => void
  }> {
    // React 19 refuses `act` outside a test environment it has been told about.
    Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(createElement(ReactNativeWebImage, { source: { uri: MOUNTED_URI } }))
    })
    const host = container.firstElementChild
    if (!(host instanceof HTMLElement)) {
      throw new Error('react-native-web rendered no host element')
    }
    return {
      host,
      rerenderWith: async (uri: string) => {
        await act(async () => {
          root.render(createElement(ReactNativeWebImage, { source: { uri } }))
        })
      },
      unmount: () => {
        root.unmount()
        container.remove()
      }
    }
  }

  /** The child RN Web put the frame on, found by the frame rather than by its position. */
  function paintedChild(host: HTMLElement): HTMLElement {
    const painted = [...host.children].filter(
      (child): child is HTMLElement =>
        child instanceof HTMLElement && child.style.backgroundImage.includes(MOUNTED_URI)
    )
    const [only, ...rest] = painted
    if (only === undefined || rest.length > 0) {
      throw new Error(`react-native-web painted ${painted.length} children, expected exactly one`)
    }
    return only
  }

  it('writes the frame onto the element react-native-web paints it on', async () => {
    const { host, unmount } = await renderImage()
    try {
      const painted = paintedChild(host)

      updateBrowserImageSourceOnWeb(asImageRef(host), STREAMED_URI)

      expect(painted.style.backgroundImage).toBe(`url("${STREAMED_URI}")`)
    } finally {
      unmount()
    }
  })

  /** The one RN Web renders beside the frame, for a screen reader and the image context menu. */
  function accessibilityImageSource(host: HTMLElement): string | null {
    const images = [...host.querySelectorAll('img')]
    if (images.length !== 1) {
      throw new Error(`react-native-web rendered ${images.length} images, expected exactly one`)
    }
    return images[0]?.getAttribute('src') ?? null
  }

  /**
   * The streaming write never reaches the accessibility `<img>`: it is a prop of RN Web's own
   * making, and the frame path writes styles.
   */
  it('leaves the accessibility image alone when a frame is written imperatively', async () => {
    const { host, unmount } = await renderImage()
    try {
      updateBrowserImageSourceOnWeb(asImageRef(host), STREAMED_URI)

      expect(accessibilityImageSource(host)).toBe(MOUNTED_URI)
    } finally {
      unmount()
    }
  })

  /**
   * A render does reach it, which is what stops the case above being "for the life of the pane".
   *
   * RN Web derives the hidden image's `src` from the same `source` prop it paints the background
   * from, so the pane's next render for any other reason — address focus, a dialog, the view mode,
   * zoom — carries `renderedFrameSource` and moves it to whatever frame is newest then.
   */
  it('moves the accessibility image on the next render from the pane state', async () => {
    const { host, rerenderWith, unmount } = await renderImage()
    try {
      updateBrowserImageSourceOnWeb(asImageRef(host), STREAMED_URI)

      await rerenderWith(STREAMED_URI)

      expect(accessibilityImageSource(host)).toBe(STREAMED_URI)
    } finally {
      unmount()
    }
  })
})
