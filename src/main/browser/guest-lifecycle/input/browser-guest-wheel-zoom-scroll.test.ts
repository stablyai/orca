import { beforeEach, describe, expect, it, vi } from 'vitest'

const agentInjection = vi.hoisted(() => ({ active: false }))
vi.mock('../../cdp/input/agent-input-injection', () => ({
  isAgentInjectingInput: () => agentInjection.active
}))

import { setupGuestMouseWheelZoomForwarding } from './browser-guest-wheel-zoom'

describe('guest before-mouse-event forwarding', () => {
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

  function sideButton(
    type: 'mouseDown' | 'mouseUp',
    button: string
  ): Partial<Electron.MouseWheelInputEvent> {
    const mouse: Partial<Electron.MouseWheelInputEvent> = {}
    // Why: overrides trigger's wheel defaults; Electron reports side buttons as 'back'/'forward'
    // at runtime, which its typing omits.
    Reflect.set(mouse, 'type', type)
    Reflect.set(mouse, 'button', button)
    return mouse
  }

  it('leaves presses an agent makes in the page to the page alone', () => {
    agentInjection.active = true
    try {
      trigger(false, sideButton('mouseDown', 'left'))
      trigger(false, sideButton('mouseUp', 'back'))
    } finally {
      agentInjection.active = false
    }
    expect(rendererSend).not.toHaveBeenCalled()
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
