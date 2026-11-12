import { describe, expect, it, vi } from 'vitest'
import {
  forwardGuestShortcutInput,
  type GuestShortcutForwardContext
} from './browser-guest-shortcut-dispatch'

const input = { key: 'Y', code: 'KeyY', control: true, shift: true }

function fixture(local = true) {
  const send = vi.fn()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: dispatch only uses send on this renderer.
  const renderer = { send } as unknown as Electron.WebContents
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: dispatch only calls preventDefault on this event.
  const event = { preventDefault: vi.fn() } as unknown as Electron.Event
  const context: GuestShortcutForwardContext & { isLocalRenderer: () => boolean } = {
    browserTabId: 'page',
    resolveRenderer: () => renderer,
    isLocalRenderer: () => local,
    getKeybindings: () => ({ 'view.plugins': ['Ctrl+Shift+Y'] }),
    forwardBrowserPageZoom: vi.fn()
  }
  return { context, event, send }
}

describe('Plugins shortcut from a browser guest', () => {
  it('replays the configured chord once, consuming repeats', () => {
    const { context, event, send } = fixture()
    expect(forwardGuestShortcutInput(context, event, input)).toBe(true)
    expect(send).toHaveBeenCalledWith('ui:browserPageTabShortcut', expect.objectContaining(input))
    expect(forwardGuestShortcutInput(context, event, { ...input, isAutoRepeat: true })).toBe(true)
    expect(send).toHaveBeenCalledOnce()
  })

  it('leaves disabled or remapped chords with the page', () => {
    const { context, event, send } = fixture()
    context.getKeybindings = () => ({ 'view.plugins': [] })
    expect(forwardGuestShortcutInput(context, event, input)).toBe(false)
    context.getKeybindings = () => ({ 'view.plugins': ['Ctrl+Shift+Z'] })
    expect(forwardGuestShortcutInput(context, event, input)).toBe(false)
    expect(send).not.toHaveBeenCalled()
  })

  it('replays a configured modifier double tap', () => {
    const { context, event, send } = fixture()
    context.getKeybindings = () => ({ 'view.plugins': ['DoubleTap+Shift'] })
    expect(forwardGuestShortcutInput(context, event, { doubleTapModifier: 'Shift' })).toBe(true)
    expect(send).toHaveBeenCalledWith(
      'ui:browserPageTabShortcut',
      expect.objectContaining({ doubleTapModifier: 'Shift' })
    )
  })

  it('leaves composing input and nonlocal renderers alone', () => {
    const { context, event, send } = fixture(false)
    expect(forwardGuestShortcutInput(context, event, input)).toBe(false)
    const local = fixture()
    expect(forwardGuestShortcutInput(local.context, local.event, { ...input, key: 'Dead' })).toBe(
      false
    )
    expect(send).not.toHaveBeenCalled()
    expect(local.send).not.toHaveBeenCalled()
  })
})
