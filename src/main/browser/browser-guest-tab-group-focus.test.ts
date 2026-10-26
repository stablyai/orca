import { describe, expect, it, vi } from 'vitest'
import { forwardGuestShortcutInput } from './browser-guest-shortcut-dispatch'

function rendererWithSend(send: Electron.WebContents['send']): Electron.WebContents {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: These paths only use send, whose signature is checked against WebContents.
  return { send } as Electron.WebContents
}

describe('split group shortcuts in a browser guest', () => {
  it.each([1, -1] as const)('forwards direction %s to the owning renderer', (direction) => {
    const send = vi.fn<Electron.WebContents['send']>()
    const preventDefault = vi.fn()
    const forwardBrowserPageZoom = vi.fn()
    const code = direction === 1 ? 'ArrowRight' : 'ArrowLeft'
    expect(
      forwardGuestShortcutInput(
        {
          browserTabId: 'page-1',
          resolveRenderer: () => rendererWithSend(send),
          forwardBrowserPageZoom,
          getKeybindings: () => ({
            'tab.focusNextGroup': ['Mod+Alt+Shift+ArrowRight'],
            'tab.focusPreviousGroup': ['Mod+Alt+Shift+ArrowLeft']
          })
        },
        { defaultPrevented: false, preventDefault },
        {
          key: code,
          code,
          meta: process.platform === 'darwin',
          control: process.platform !== 'darwin',
          alt: true,
          shift: true
        }
      )
    ).toBe(true)
    expect(preventDefault).toHaveBeenCalledOnce()
    expect(send).toHaveBeenCalledExactlyOnceWith('ui:focusTabGroup', direction, 'page-1')
  })

  it('contains held-key repeats without moving through further groups', () => {
    const send = vi.fn<Electron.WebContents['send']>()
    const preventDefault = vi.fn()
    expect(
      forwardGuestShortcutInput(
        {
          browserTabId: 'page-1',
          resolveRenderer: () => rendererWithSend(send),
          forwardBrowserPageZoom: vi.fn()
        },
        { defaultPrevented: false, preventDefault },
        { isAutoRepeat: true },
        { type: 'focusTabGroup', direction: 1 }
      )
    ).toBe(true)
    expect(preventDefault).toHaveBeenCalledOnce()
    expect(send).not.toHaveBeenCalled()
  })
})
