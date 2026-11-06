// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('react-native', () => vi.importActual<typeof import('react-native')>('react-native-web'))
vi.mock('lucide-react-native', () => ({
  ArrowUp: () => createElement('svg', { 'data-icon': 'up' }, createElement('path', { d: 'M1 1' })),
  ArrowDown: () =>
    createElement('svg', { 'data-icon': 'down' }, createElement('path', { d: 'M1 1' }))
}))

import { MobileNativeChatFloatingControls } from './MobileNativeChatFloatingControls'

describe('jump arrow glyph hits', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  afterEach(() => {
    act(() => {
      root?.unmount()
    })
    container?.remove()
    root = undefined
    container = undefined
  })

  async function render(onJumpToPrevious: (animated: boolean) => void): Promise<void> {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root?.render(
        <MobileNativeChatFloatingControls
          showJumpToTail
          onJumpToTail={() => undefined}
          showPreviousMessage
          onJumpToPrevious={onJumpToPrevious}
        />
      )
    })
  }

  it('runs onPress when the click lands on the icon path', async () => {
    const onJumpToPrevious = vi.fn<(animated: boolean) => void>()
    await render(onJumpToPrevious)
    const button = container?.querySelector('[aria-label="Previous message"]')
    if (!(button instanceof HTMLElement)) {
      throw new Error('Previous message button is missing')
    }
    const path = button.querySelector('path')
    if (!(path instanceof SVGPathElement)) {
      throw new Error('Previous message icon path is missing')
    }
    const svg = path.ownerSVGElement
    if (!(svg instanceof SVGElement)) {
      throw new Error('Previous message icon is missing')
    }
    expect(getComputedStyle(svg).pointerEvents).toBe('none')
    const arrows = container?.querySelectorAll('svg') ?? []
    expect(arrows).toHaveLength(2)
    for (const arrow of arrows) {
      expect(getComputedStyle(arrow).pointerEvents).toBe('none')
    }
    await act(async () => {
      path.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    expect(onJumpToPrevious).toHaveBeenCalledTimes(1)
  })
})
