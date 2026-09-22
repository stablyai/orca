import { beforeEach, describe, expect, it, vi } from 'vitest'
import { setupGuestMouseWheelZoomForwarding } from './browser-guest-wheel-zoom'

describe('guest viewport wheel forwarding', () => {
  const rendererSend = vi.fn()
  const guestOn = vi.fn()

  beforeEach(() => {
    rendererSend.mockReset()
    guestOn.mockReset()
  })

  function trigger(
    active: boolean,
    mouse: Partial<Electron.MouseWheelInputEvent>
  ): ReturnType<typeof vi.fn> {
    setupGuestMouseWheelZoomForwarding({
      browserTabId: 'tab-1',
      guest: { on: guestOn } as unknown as Electron.WebContents,
      resolveRenderer: () => ({ send: rendererSend }) as unknown as Electron.WebContents,
      isViewportPresetActive: () => active,
      canViewportScroll: () => active
    })
    const handler = guestOn.mock.calls.at(-1)![1] as (
      event: Electron.Event,
      input: Electron.MouseInputEvent
    ) => void
    const preventDefault = vi.fn()
    handler({ preventDefault } as unknown as Electron.Event, {
      type: 'mouseWheel',
      x: 0,
      y: 0,
      modifiers: [],
      deltaX: 0,
      deltaY: 0,
      ...mouse
    })
    return preventDefault
  }

  it('forwards plain wheel deltas only for an active preset', () => {
    const preventDefault = trigger(true, { deltaX: 24, deltaY: 120 })

    expect(preventDefault).toHaveBeenCalledTimes(1)
    expect(rendererSend).toHaveBeenCalledWith('ui:scrollBrowserPage', {
      browserPageId: 'tab-1',
      deltaX: 24,
      deltaY: 120
    })

    trigger(false, { deltaY: 120 })
    expect(rendererSend).toHaveBeenCalledTimes(1)
  })

  it('ignores zero deltas and preserves ctrl-wheel zoom routing', () => {
    const zeroPreventDefault = trigger(true, {})
    expect(zeroPreventDefault).not.toHaveBeenCalled()

    const zoomPreventDefault = trigger(true, { modifiers: ['ctrl'], deltaY: -120 })
    expect(zoomPreventDefault).toHaveBeenCalledTimes(1)
    expect(rendererSend).toHaveBeenLastCalledWith('ui:zoomBrowserPage', 'in')
  })

  it('leaves fitting presets and host-edge wheels to the guest page', () => {
    setupGuestMouseWheelZoomForwarding({
      browserTabId: 'tab-1',
      guest: { on: guestOn } as unknown as Electron.WebContents,
      resolveRenderer: () => ({ send: rendererSend }) as unknown as Electron.WebContents,
      isViewportPresetActive: () => true,
      canViewportScroll: () => false
    })
    const handler = guestOn.mock.calls.at(-1)![1] as (
      event: Electron.Event,
      input: Electron.MouseWheelInputEvent
    ) => void
    const preventDefault = vi.fn()
    handler(
      { preventDefault } as unknown as Electron.Event,
      {
        type: 'mouseWheel',
        x: 0,
        y: 0,
        modifiers: [],
        deltaX: 0,
        deltaY: 120
      } as Electron.MouseWheelInputEvent
    )

    expect(preventDefault).not.toHaveBeenCalled()
    expect(rendererSend).not.toHaveBeenCalled()
  })
})
