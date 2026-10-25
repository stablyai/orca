import { afterEach, describe, expect, it, vi } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../shared/constants'
import type { KeybindingOverrides } from '../../shared/keybindings'
import { forwardGuestShortcutInput } from './browser-guest-shortcut-dispatch'

// Why: a function key keeps the chord clear of every platform's default bindings and AltGr handling.
const keybindings = { 'tab.focusGroupRight': ['Ctrl+F9'] }
const input = { key: 'F9', code: 'F9', control: true, meta: false, alt: false, shift: false }

function forward(
  worktreeId: string,
  options: { input?: typeof input; keybindings?: KeybindingOverrides } = {}
) {
  const send = vi.fn()
  const preventDefault = vi.fn()
  const handled = forwardGuestShortcutInput(
    {
      browserTabId: 'page-1',
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: dispatch only calls send() on the resolved renderer.
      resolveRenderer: () => ({ send }) as unknown as Electron.WebContents,
      getKeybindings: () => options.keybindings ?? keybindings,
      resolveWorktreeId: () => worktreeId,
      forwardBrowserPageZoom: vi.fn()
    },
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: dispatch only calls preventDefault() on the event.
    { preventDefault } as unknown as Electron.Event,
    options.input ?? input,
    null
  )
  return { handled, send, preventDefault }
}

describe('browser guest tab group focus', () => {
  const originalPlatform = process.platform

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform })
  })

  it('forwards the macOS default Ctrl+Option+H even when Option composes the key', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    const { handled, send } = forward('wt-1', {
      keybindings: {},
      input: { key: '˙', code: 'KeyH', control: true, meta: false, alt: true, shift: false }
    })
    expect(handled).toBe(true)
    expect(send).toHaveBeenCalledWith('ui:focusTabGroup', 'left')
  })

  it('forwards the chord to the renderer and keeps it from the page', () => {
    const { handled, send, preventDefault } = forward('wt-1')
    expect(handled).toBe(true)
    expect(send).toHaveBeenCalledWith('ui:focusTabGroup', 'right')
    expect(preventDefault).toHaveBeenCalled()
  })

  it('leaves floating-panel guests alone', () => {
    const { handled, send } = forward(FLOATING_TERMINAL_WORKTREE_ID)
    expect(handled).toBe(false)
    expect(send).not.toHaveBeenCalledWith('ui:focusTabGroup', expect.anything())
  })
})
