// @vitest-environment happy-dom
import { createRequire } from 'node:module'
import { act, createElement, type ComponentType } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import type { Image } from 'react-native'
import { updateBrowserImageSource as updateBrowserImageSourceOnWeb } from './browser-frame-layer-paint.web'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the point of the test is that a DOM node is what the native signature receives on RN Web, which is exactly the mismatch these siblings exist for.
const asImageRef = (node: HTMLElement) => node as unknown as Image

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
})
