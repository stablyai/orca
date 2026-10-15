import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  screen: { getCursorScreenPoint: vi.fn(() => ({ x: 0, y: 0 })) },
  webContents: { fromId: vi.fn() }
}))

import { setupGuestShortcutForwarding } from './browser-guest-shortcut-forwarding'

describe('next-attention shortcut from a focused browser guest', () => {
  let rendererSend: ReturnType<typeof vi.fn>
  let guestOn: ReturnType<typeof vi.fn>

  beforeEach(() => {
    rendererSend = vi.fn()
    guestOn = vi.fn()
    setupGuestShortcutForwarding({
      browserTabId: 'tab-1',
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: forwarding only subscribes through on/off.
      guest: { on: guestOn, off: vi.fn() } as unknown as Electron.WebContents,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: forwarding only calls send on the renderer.
      resolveRenderer: () => ({ send: rendererSend }) as unknown as Electron.WebContents,
      getKeybindings: () => ({ 'workspace.nextAttention': ['Mod+Shift+L'] })
    })
  })

  function press(isAutoRepeat: boolean): ReturnType<typeof vi.fn> {
    const handler = guestOn.mock.calls.find((call) => call[0] === 'before-input-event')?.[1]
    expect(handler).toBeTypeOf('function')
    const preventDefault = vi.fn()
    const isMac = process.platform === 'darwin'
    handler(
      { preventDefault },
      {
        type: 'keyDown',
        code: 'KeyL',
        key: 'L',
        alt: false,
        meta: isMac,
        control: !isMac,
        shift: true,
        isAutoRepeat
      }
    )
    return preventDefault
  }

  it('forwards a fresh press to the renderer', () => {
    const preventDefault = press(false)

    expect(preventDefault).toHaveBeenCalledTimes(1)
    expect(rendererSend).toHaveBeenCalledWith('ui:jumpToNextAttention')
  })

  it('swallows held-key repeats instead of jumping again or leaking them to the page', () => {
    const preventDefault = press(true)

    expect(preventDefault).toHaveBeenCalledTimes(1)
    expect(rendererSend).not.toHaveBeenCalled()
  })
})
