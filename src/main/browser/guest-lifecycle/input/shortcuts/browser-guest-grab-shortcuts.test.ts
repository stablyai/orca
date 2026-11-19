import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../cdp/input/agent-input-injection', () => ({
  isAgentInjectingInput: () => false
}))

import { setupGrabShortcutForwarding } from './browser-guest-grab-shortcuts'

type Handler = (event: { preventDefault: () => void }, input: Partial<Electron.Input>) => void

function setup(activeGrab: boolean | (() => boolean)): {
  press: (input: Partial<Electron.Input>) => boolean
  send: ReturnType<typeof vi.fn>
} {
  let handler: Handler | null = null
  const guestFixture = {
    on: (_event: string, fn: Handler) => {
      handler = fn
    },
    off: vi.fn(),
    executeJavaScript: vi.fn(async () => false)
  }
  const send = vi.fn()
  const rendererFixture = { send }
  setupGrabShortcutForwarding({
    browserTabId: 'page-1',
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the forwarder only calls on/off/executeJavaScript, which this fixture implements.
    guest: guestFixture as unknown as Electron.WebContents,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the forwarder only calls send on the renderer, which this fixture implements.
    resolveRenderer: () => rendererFixture as unknown as Electron.WebContents,
    hasActiveGrabOp: typeof activeGrab === 'function' ? activeGrab : () => activeGrab
  })
  return {
    send,
    press: (input) => {
      const preventDefault = vi.fn()
      handler?.(
        { preventDefault },
        {
          type: 'keyDown',
          meta: false,
          control: false,
          alt: false,
          shift: false,
          ...input
        }
      )
      return preventDefault.mock.calls.length > 0
    }
  }
}

describe('grab shortcut forwarding from a focused page', () => {
  it('forwards the A/G/D tool keys while a pick is running, so the page never types them', () => {
    const { press, send } = setup(true)
    for (const [key, code] of [
      ['a', 'KeyA'],
      ['g', 'KeyG'],
      ['d', 'KeyD']
    ]) {
      expect(press({ key, code })).toBe(true)
      expect(send).toHaveBeenLastCalledWith('browser:grabActionShortcut', {
        browserPageId: 'page-1',
        key
      })
    }
  })

  it('swallows a held tool key without switching again', () => {
    const { press, send } = setup(true)
    expect(press({ key: 'd', code: 'KeyD', isAutoRepeat: true })).toBe(true)
    expect(send).not.toHaveBeenCalled()
  })

  it('mirrors Alt down and up from the page while picking, without taking it from the page', () => {
    const { press, send } = setup(true)
    expect(press({ key: 'Alt', code: 'AltLeft', alt: true })).toBe(false)
    expect(send).toHaveBeenLastCalledWith('browser:grabActionShortcut', {
      browserPageId: 'page-1',
      key: 'alt-down'
    })
    expect(press({ type: 'keyUp', key: 'Alt', code: 'AltLeft' })).toBe(false)
    expect(send).toHaveBeenLastCalledWith('browser:grabActionShortcut', {
      browserPageId: 'page-1',
      key: 'alt-up'
    })
  })

  it('matches the physical key on non-Latin layouts', () => {
    const { press, send } = setup(true)
    expect(press({ key: 'п', code: 'KeyG' })).toBe(true)
    expect(send).toHaveBeenCalledWith('browser:grabActionShortcut', {
      browserPageId: 'page-1',
      key: 'g'
    })
  })

  it('leaves tool keys to the page with a modifier held or when no pick is running', () => {
    const withModifier = setup(true)
    expect(withModifier.press({ key: 'g', code: 'KeyG', meta: true })).toBe(false)
    expect(withModifier.send).not.toHaveBeenCalled()

    const idle = setup(false)
    expect(idle.press({ key: 'g', code: 'KeyG' })).toBe(false)
    expect(idle.send).not.toHaveBeenCalled()
  })

  it('still releases Alt when the pick ends while Alt is held', () => {
    let picking = true
    const { press, send } = setup(() => picking)
    press({ key: 'Alt', code: 'AltLeft', alt: true })
    picking = false

    press({ type: 'keyUp', key: 'Alt', code: 'AltLeft' })

    expect(send).toHaveBeenLastCalledWith('browser:grabActionShortcut', {
      browserPageId: 'page-1',
      key: 'alt-up'
    })
  })
})
