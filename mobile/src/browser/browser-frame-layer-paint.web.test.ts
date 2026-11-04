// @vitest-environment happy-dom
import { createRequire } from 'node:module'
import { act, createElement, type ComponentType } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import type { Image, View } from 'react-native'
import {
  updateBrowserImageSource as updateBrowserImageSourceOnWeb,
  updateBrowserLayerVisibility as updateBrowserLayerVisibilityOnWeb,
  whenBrowserFrameDisplayable as whenBrowserFrameDisplayableOnWeb
} from './browser-frame-layer-paint.web'

/** A 1x1 gif, so the probe in the web sibling has something a real decoder would accept. */
const FRAME_URI = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'

// RN Web Image ref is outer host; first child holds background-image and resizeMode styles.
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

  // happy-dom has no decoder and always resolves decode; stub rejection to prove failed frame frees pending layer instead of freezing pane.
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

// Test actual RN Web Image alongside synthetic div fixtures: child reorder could leave fixtures green while writer paints wrong node.
// Find rendered frame element by its background and verify write lands there.
describe('against a real react-native-web Image', () => {
  // createRequire avoids implicit-any import from untyped RN Web, preserving test typecheck; declare the sole rendered prop instead of asserting.
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

  // Streaming writes styles, leaving RN Web’s prop-driven accessibility img unchanged.
  it('leaves the accessibility image alone when a frame is written imperatively', async () => {
    const { host, unmount } = await renderImage()
    try {
      updateBrowserImageSourceOnWeb(asImageRef(host), STREAMED_URI)

      expect(accessibilityImageSource(host)).toBe(MOUNTED_URI)
    } finally {
      unmount()
    }
  })

  // Any later pane render updates hidden img from newest renderedFrameSource, including focus/dialog/view/zoom changes.
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
