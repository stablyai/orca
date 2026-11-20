import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../cdp/input/agent-input-injection', () => ({
  isAgentInjectingInput: () => false
}))

import { setupGrabShortcutForwarding } from './browser-guest-grab-shortcuts'

type Handler = (event: { preventDefault: () => void }, input: Partial<Electron.Input>) => void

/** Lets a held letter get the page's answer (main asks the page before taking a letter). */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

function setup(
  activeGrab: boolean | (() => boolean),
  editableFocused: () => boolean = () => false,
  pageHasField: () => boolean = () => false
): {
  press: (input: Partial<Electron.Input>) => boolean
  send: ReturnType<typeof vi.fn>
  blur: () => void
} {
  let handler: Handler | null = null
  let onBlur: (() => void) | null = null
  const guestFixture = {
    on: (event: string, fn: Handler & (() => void)) => {
      if (event === 'blur') {
        onBlur = fn
      } else {
        handler = fn
      }
    },
    off: vi.fn(),
    isDestroyed: () => false,
    sendInputEvent: vi.fn(),
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
    hasActiveGrabOp: typeof activeGrab === 'function' ? activeGrab : () => activeGrab,
    isGuestEditableFocused: editableFocused,
    askPageHasField: async () => pageHasField()
  })
  return {
    send,
    blur: () => onBlur?.(),
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
  it('forwards the A/G/D tool keys while a pick is running, so the page never types them', async () => {
    const { press, send } = setup(true)
    for (const [key, code] of [
      ['a', 'KeyA'],
      ['g', 'KeyG'],
      ['d', 'KeyD']
    ]) {
      expect(press({ key, code })).toBe(true)
      await settle()
      expect(send).toHaveBeenLastCalledWith('browser:grabActionShortcut', {
        browserPageId: 'page-1',
        key
      })
    }
  })

  it('lets a page field keep its typing while it has focus during a pick, and takes letters again once it loses it', async () => {
    let fieldFocused = true
    const { press, send } = setup(true, () => fieldFocused)

    for (const [key, code] of [
      ['c', 'KeyC'],
      ['s', 'KeyS'],
      ['d', 'KeyD']
    ]) {
      expect(press({ key, code })).toBe(false)
    }
    expect(send).not.toHaveBeenCalled()

    fieldFocused = false
    expect(press({ key: 'g', code: 'KeyG' })).toBe(true)
    await settle()
    expect(send).toHaveBeenLastCalledWith('browser:grabActionShortcut', {
      browserPageId: 'page-1',
      key: 'g'
    })
  })

  it("leaves AltGr's characters to the page while AltGr is held, even letters that map to a tool key", async () => {
    const { press, send } = setup(true)
    press({ key: 'AltGraph', code: 'AltRight' })
    // A layout whose AltGr level types Greek: γ sits on the G key.
    expect(press({ key: 'γ', code: 'KeyG' })).toBe(false)
    expect(send).not.toHaveBeenCalled()

    press({ type: 'keyUp', key: 'AltGraph', code: 'AltRight' })
    expect(press({ key: 'g', code: 'KeyG' })).toBe(true)
    await settle()
  })

  it.each([
    ['the page loses focus', 'blur'],
    ['the pick ends and a new one starts', 'new pick']
  ] as const)(
    'forgets a held AltGr when %s (its release may happen elsewhere)',
    async (_label, reset) => {
      let picking = true
      const { press, send, blur } = setup(() => picking)
      press({ key: 'AltGraph', code: 'AltRight' })
      expect(press({ key: 'g', code: 'KeyG' })).toBe(false)

      if (reset === 'blur') {
        blur()
      } else {
        picking = false
        press({ key: 'Shift', code: 'ShiftLeft' })
        picking = true
      }

      expect(press({ key: 'g', code: 'KeyG' })).toBe(true)
      await settle()
      expect(send).toHaveBeenLastCalledWith('browser:grabActionShortcut', {
        browserPageId: 'page-1',
        key: 'g'
      })
    }
  )

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

  it('matches the physical key on non-Latin layouts', async () => {
    const { press, send } = setup(true)
    expect(press({ key: 'п', code: 'KeyG' })).toBe(true)
    await settle()
    expect(send).toHaveBeenCalledWith('browser:grabActionShortcut', {
      browserPageId: 'page-1',
      key: 'g'
    })
  })

  it('does not mirror Alt down when no pick is running', () => {
    const { press, send } = setup(false)

    press({ key: 'Alt', code: 'AltLeft', alt: true })

    expect(send).not.toHaveBeenCalled()
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

  it('releases Alt that went down while the app had focus and came up in the page after the pick settled', () => {
    // Down in the app (the page never saw it), the pick then settles, then Alt comes up in the page.
    const { press, send } = setup(false)

    press({ type: 'keyUp', key: 'Alt', code: 'AltLeft' })

    expect(send).toHaveBeenLastCalledWith('browser:grabActionShortcut', {
      browserPageId: 'page-1',
      key: 'alt-up'
    })
  })

  it('follows the letter on the key for Latin layouts, not its physical position', async () => {
    const { press, send } = setup(true)
    // AZERTY: the key labelled A sits where QWERTY has Q.
    press({ key: 'a', code: 'KeyQ' })
    await settle()
    expect(send).toHaveBeenLastCalledWith('browser:grabActionShortcut', {
      browserPageId: 'page-1',
      key: 'a'
    })
    send.mockClear()
    // Dvorak: J sits where QWERTY has C, and must not copy.
    expect(press({ key: 'j', code: 'KeyC' })).toBe(false)
    // Colemak: R sits where QWERTY has S, and must not take a screenshot.
    expect(press({ key: 'r', code: 'KeyS' })).toBe(false)
    expect(send).not.toHaveBeenCalled()
  })

  it('ignores the tool letters with Shift held', () => {
    const { press, send } = setup(true)
    for (const [key, code] of [
      ['C', 'KeyC'],
      ['S', 'KeyS'],
      ['A', 'KeyA'],
      ['G', 'KeyG'],
      ['D', 'KeyD']
    ]) {
      expect(press({ key, code, shift: true })).toBe(false)
    }
    expect(send).not.toHaveBeenCalled()
  })

  it('never maps accented letters, dead keys or IME composition onto a tool', () => {
    const { press, send } = setup(true)
    // German ü sits where QWERTY has [, Polish ą is AltGr+A, a dead key waits for the next key.
    expect(press({ key: 'ü', code: 'BracketLeft' })).toBe(false)
    expect(press({ key: 'ą', code: 'KeyA' })).toBe(false)
    expect(press({ key: 'Dead', code: 'KeyC' })).toBe(false)
    expect(press({ key: 'a', code: 'KeyA', isComposing: true })).toBe(false)
    expect(send).not.toHaveBeenCalled()
  })
})
