import { describe, expect, it, vi } from 'vitest'
import type { OffscreenPageUserInput } from '../../shared/offscreen-page-protocol'
import { createOffscreenPageFrames } from './offscreen-page-frames'
import {
  dispatchOffscreenPageUserInput,
  electronKeyInput,
  electronWheelEvent
} from './offscreen-page-user-input'

function fakePage(attached = true) {
  const target = { isDestroyed: () => false, sendInputEvent: vi.fn(), getZoomFactor: () => 2 }
  const session = {
    send: vi.fn((_method: string, _params?: Record<string, unknown>, _sessionId?: string) =>
      Promise.resolve(attached ? {} : undefined)
    ),
    onMessage: vi.fn(() => () => {}),
    dispose: vi.fn()
  }
  const frames = createOffscreenPageFrames(session, () => [])
  const dispatch = (input: OffscreenPageUserInput, platform: NodeJS.Platform = 'darwin') =>
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fake implements every WebContents member dispatch touches.
    dispatchOffscreenPageUserInput(target as never, { session, frames }, input, platform)
  return { target, session, dispatch }
}

type KeyInput = Extract<OffscreenPageUserInput, { kind: 'key' }>

const key = (overrides: Partial<KeyInput>): KeyInput => ({
  kind: 'key',
  type: 'keyDown',
  key: 'a',
  code: 'KeyA',
  keyCode: 65,
  location: 0,
  repeat: false,
  text: 'a',
  modifiers: [],
  ...overrides
})

describe('dispatchOffscreenPageUserInput', () => {
  it('sends a typed key over CDP with its code, text and location', async () => {
    const { session, dispatch } = fakePage()
    await dispatch(key({ location: 3, key: '1', code: 'Numpad1', keyCode: 97, text: '1' }))
    expect(session.send).toHaveBeenCalledWith('Input.dispatchKeyEvent', {
      type: 'keyDown',
      modifiers: 0,
      key: '1',
      code: 'Numpad1',
      windowsVirtualKeyCode: 97,
      nativeVirtualKeyCode: 97,
      autoRepeat: false,
      location: 3,
      isKeypad: true,
      text: '1',
      unmodifiedText: '1'
    })
  })

  it('adds macOS editing commands only on macOS', async () => {
    const mac = fakePage()
    await mac.dispatch(key({ key: 'c', code: 'KeyC', text: '', modifiers: ['meta'] }))
    expect(mac.session.send.mock.calls[0][1]).toMatchObject({
      type: 'rawKeyDown',
      modifiers: 4,
      commands: ['copy']
    })
    const linux = fakePage()
    await linux.dispatch(key({ key: 'c', code: 'KeyC', text: '', modifiers: ['control'] }), 'linux')
    expect(linux.session.send.mock.calls[0][1]).not.toHaveProperty('commands')
  })

  it('falls back to sendInputEvent when the page has no debugger', async () => {
    const { target, dispatch } = fakePage(false)
    await dispatch(key({}))
    expect(target.sendInputEvent.mock.calls).toEqual([
      [{ type: 'keyDown', keyCode: 'a', modifiers: [] }],
      [{ type: 'char', keyCode: 'a', modifiers: [] }]
    ])
  })

  it('sends the mouse over CDP in CSS px with held buttons', async () => {
    const { target, session, dispatch } = fakePage()
    const mouse = { kind: 'mouse' as const, x: 4.4, y: 5.6, clickCount: 1, modifiers: [] }
    await dispatch({
      ...mouse,
      type: 'mouseMove',
      button: 'left',
      clickCount: 0,
      heldButtons: ['left']
    })
    await dispatch({ ...mouse, type: 'mouseDown', button: 'back', heldButtons: [] })
    const mouseCalls = session.send.mock.calls.filter(([method]) => method.startsWith('Input.'))
    expect(mouseCalls.map(([, params]) => params)).toEqual([
      {
        type: 'mouseMoved',
        x: 2.2,
        y: 2.8,
        button: 'left',
        buttons: 1,
        clickCount: 0,
        modifiers: 0
      },
      {
        type: 'mousePressed',
        x: 2.2,
        y: 2.8,
        button: 'back',
        buttons: 8,
        clickCount: 1,
        modifiers: 0
      }
    ])
    expect(target.sendInputEvent).not.toHaveBeenCalled()
  })

  it('leaves the page and falls back without a debugger through sendInputEvent', async () => {
    const { target, dispatch } = fakePage(false)
    const mouse = { kind: 'mouse' as const, x: 1, y: 2, clickCount: 0, modifiers: [] }
    await dispatch({ ...mouse, type: 'mouseLeave', button: 'left', heldButtons: [] })
    await dispatch({ ...mouse, type: 'mouseMove', button: 'left', heldButtons: ['left'] })
    expect(
      target.sendInputEvent.mock.calls.map(([event]) => [event.type, event.modifiers])
    ).toEqual([
      ['mouseLeave', []],
      ['mouseMove', ['leftbuttondown']]
    ])
  })
})

describe('Electron input shapes', () => {
  it('rounds a wheel to whole pixels and keeps its deltas', () => {
    expect(
      electronWheelEvent({ kind: 'wheel', x: 10.6, y: 4.2, deltaX: 1, deltaY: -2, modifiers: [] })
    ).toEqual({ type: 'mouseWheel', x: 11, y: 4, deltaX: 1, deltaY: -2, modifiers: [] })
  })

  it('spells a key the way before-input-event does', () => {
    expect(electronKeyInput(key({ modifiers: ['meta', 'shift'] }))).toEqual({
      type: 'keyDown',
      key: 'a',
      code: 'KeyA',
      meta: true,
      control: false,
      alt: false,
      shift: true,
      isAutoRepeat: false
    })
  })
})
