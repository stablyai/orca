import { createElement, useEffect } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PanZoomSize } from '../../../src/shared/pan-zoom-view'

vi.mock('react-native', () => ({
  BackHandler: {
    addEventListener: () => ({ remove() {} })
  }
}))

import {
  useMobilePanZoom,
  type MobilePanZoom,
  type MobilePanZoomDismiss
} from './use-mobile-pan-zoom'

// SAFETY: the hook only reads client size, bounds, and pointer capture from the canvas.
const canvas = {
  clientWidth: 320,
  clientHeight: 640,
  getBoundingClientRect: () => ({ left: 0, top: 0, width: 320, height: 640 }),
  setPointerCapture() {}
} as unknown as HTMLDivElement

class ResizeObserver {
  constructor(private readonly notify: () => void) {}
  observe(): void {
    this.notify()
  }
  disconnect(): void {}
}

function dismissSpies() {
  return {
    onMove: vi.fn<(translationY: number) => void>(),
    onRelease: vi.fn<(translationY: number, velocityY: number) => void>(),
    onCancel: vi.fn<() => void>()
  }
}

describe('useMobilePanZoom dismiss', () => {
  let renderer: ReactTestRenderer | null = null
  let latest: MobilePanZoom | null = null

  function Probe({
    dismiss = null,
    content
  }: {
    dismiss?: MobilePanZoomDismiss | null
    content: PanZoomSize | null
  }): null {
    const zoom = useMobilePanZoom(content, false, dismiss)
    useEffect(() => {
      zoom.setCanvas(canvas)
    }, [zoom.setCanvas])
    latest = zoom
    return null
  }

  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', ResizeObserver)
    latest = null
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  async function mount(
    dismiss: MobilePanZoomDismiss | null,
    content: PanZoomSize | null = { width: 400, height: 400 }
  ): Promise<void> {
    await act(async () => {
      renderer = create(createElement(Probe, { dismiss, content }))
    })
  }

  function pointer(
    kind: 'down' | 'move' | 'up' | 'cancel',
    id: number,
    x: number,
    y: number,
    time: number
  ): void {
    const type =
      kind === 'down'
        ? 'pointerdown'
        : kind === 'move'
          ? 'pointermove'
          : kind === 'cancel'
            ? 'pointercancel'
            : 'pointerup'
    const event = {
      pointerId: id,
      clientX: x,
      clientY: y,
      timeStamp: time,
      type,
      currentTarget: canvas
    }
    const handlers = latest?.handlers
    act(() => {
      if (kind === 'down') {
        handlers?.onPointerDown?.(event as never)
      } else if (kind === 'move') {
        handlers?.onPointerMove?.(event as never)
      } else if (kind === 'cancel') {
        handlers?.onPointerCancel?.(event as never)
      } else {
        handlers?.onPointerUp?.(event as never)
      }
    })
  }

  it('follows a vertical finger at the fitted size and ignores a horizontal one', async () => {
    const dismiss = dismissSpies()
    await mount(dismiss)
    expect(latest?.scale).toBeGreaterThan(0)

    pointer('down', 1, 100, 200, 0)
    pointer('move', 1, 108, 230, 30)
    pointer('up', 1, 108, 230, 40)
    expect(dismiss.onMove).toHaveBeenCalledWith(30)
    expect(dismiss.onRelease).toHaveBeenCalledWith(30, 1000)
    expect(dismiss.onCancel).not.toHaveBeenCalled()

    dismiss.onMove.mockClear()
    dismiss.onRelease.mockClear()
    pointer('down', 1, 100, 200, 100)
    pointer('move', 1, 160, 210, 130)
    pointer('up', 1, 160, 210, 140)
    expect(dismiss.onMove).not.toHaveBeenCalled()
    expect(dismiss.onRelease).not.toHaveBeenCalled()
  })

  it('drops a flick that paused before release', async () => {
    const dismiss = dismissSpies()
    await mount(dismiss)
    pointer('down', 1, 40, 40, 0)
    pointer('move', 1, 40, 90, 20)
    pointer('up', 1, 40, 90, 200)
    expect(dismiss.onRelease).toHaveBeenCalledWith(50, 0)
  })

  it('cancels a dismiss when a second finger pinches, and pans once zoomed', async () => {
    const dismiss = dismissSpies()
    await mount(dismiss)
    pointer('down', 1, 40, 200, 0)
    pointer('move', 1, 40, 250, 20)
    expect(dismiss.onMove).toHaveBeenCalled()
    pointer('down', 2, 140, 200, 24)
    expect(dismiss.onCancel).toHaveBeenCalled()

    const fitted = latest?.offset
    pointer('move', 2, 260, 200, 40)
    pointer('up', 2, 260, 200, 48)
    pointer('up', 1, 40, 250, 50)
    expect(latest?.scale).toBeGreaterThan(0.72)

    dismiss.onMove.mockClear()
    dismiss.onRelease.mockClear()
    pointer('down', 1, 80, 200, 80)
    pointer('move', 1, 80, 280, 100)
    pointer('up', 1, 80, 280, 110)
    expect(dismiss.onMove).not.toHaveBeenCalled()
    expect(dismiss.onRelease).not.toHaveBeenCalled()
    expect(latest?.offset).not.toEqual(fitted)
  })

  it('leaves previews without a dismiss handler on the pan path', async () => {
    await mount(null)
    expect(() => {
      pointer('down', 1, 20, 20, 0)
      pointer('move', 1, 20, 80, 16)
      pointer('up', 1, 20, 80, 20)
    }).not.toThrow()
  })
})
