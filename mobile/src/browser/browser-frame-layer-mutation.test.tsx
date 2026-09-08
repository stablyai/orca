// @vitest-environment jsdom
import { act, createElement, createRef } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import type { Image as ImageType, View as ViewType } from 'react-native'
import { setBrowserImageUri, setBrowserLayerOpacity } from './browser-frame-layer-mutation'

// Renders the real react-native-web primitives, which is what the hybrid WebView loads.
vi.mock('react-native', async () => await import('react-native-web'))

const FRAME_A = 'data:image/jpeg;base64,QUFB'
const FRAME_B = 'data:image/jpeg;base64,QkJC'

async function mount(element: ReturnType<typeof createElement>): Promise<HTMLElement> {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const container = document.createElement('div')
  document.body.appendChild(container)
  await act(async () => {
    createRoot(container).render(element)
  })
  return container
}

describe('browser frame layer mutation on react-native-web', () => {
  it('uses setNativeProps when the ref exposes it', () => {
    const setNativeProps = vi.fn()
    setBrowserLayerOpacity({ setNativeProps } as unknown as ViewType, 0)
    setBrowserImageUri({ setNativeProps } as unknown as ImageType, FRAME_A)
    expect(setNativeProps).toHaveBeenNthCalledWith(1, { style: { opacity: 0 } })
    expect(setNativeProps).toHaveBeenNthCalledWith(2, {
      source: [{ uri: FRAME_A }],
      src: [{ uri: FRAME_A }]
    })
  })

  it('toggles a DOM layer without throwing when the ref is a web node', async () => {
    const { View } = await import('react-native')
    const ref = createRef<ViewType>()
    await mount(createElement(View, { ref }))
    const node = ref.current as unknown as HTMLElement
    expect(typeof (node as unknown as { setNativeProps?: unknown }).setNativeProps).toBe(
      'undefined'
    )
    setBrowserLayerOpacity(ref.current, 0)
    expect(node.style.opacity).toBe('0')
    setBrowserLayerOpacity(ref.current, 1)
    expect(node.style.opacity).toBe('1')
  })

  it('repaints a DOM image layer with the next streamed frame', async () => {
    const { Image } = await import('react-native')
    const ref = createRef<ImageType>()
    await mount(createElement(Image, { ref, source: { uri: FRAME_A } }))
    const node = ref.current as unknown as HTMLElement
    setBrowserImageUri(ref.current, FRAME_B)
    const painted = Array.from(node.children).find(
      (child) => (child as HTMLElement).style.backgroundImage !== ''
    ) as HTMLElement | undefined
    expect(painted?.style.backgroundImage).toContain(FRAME_B)
    expect(node.querySelector('img')?.getAttribute('src')).toBe(FRAME_B)
  })
})
