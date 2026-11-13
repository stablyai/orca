import { describe, expect, it, vi } from 'vitest'
import {
  forwardGuestShortcutInput,
  type GuestShortcutForwardContext
} from './browser-guest-shortcut-dispatch'

const input = {
  key: 'Y',
  code: 'KeyY',
  meta: process.platform === 'darwin',
  control: process.platform !== 'darwin',
  shift: true
}
const primaryDoubleTap = process.platform === 'darwin' ? 'Cmd' : 'Ctrl'

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
    getKeybindings: () => ({ 'view.plugins': ['Mod+Shift+Y'] }),
    forwardBrowserPageZoom: vi.fn()
  }
  return { context, event, send }
}

function withPlatform(platform: NodeJS.Platform, run: () => void): void {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')
  if (!descriptor) {
    throw new Error('Missing process.platform descriptor')
  }
  Object.defineProperty(process, 'platform', { ...descriptor, value: platform })
  try {
    run()
  } finally {
    Object.defineProperty(process, 'platform', descriptor)
  }
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
    context.getKeybindings = () => ({ 'view.plugins': ['Mod+Shift+Z'] })
    expect(forwardGuestShortcutInput(context, event, input)).toBe(false)
    expect(send).not.toHaveBeenCalled()
  })

  it('leaves text-producing custom bindings to the guest', () => {
    const { context, event, send } = fixture()
    context.getKeybindings = () => ({ 'view.plugins': ['Alt+A'] })
    expect(forwardGuestShortcutInput(context, event, { key: 'å', code: 'KeyA', alt: true })).toBe(
      false
    )
    expect(forwardGuestShortcutInput(context, event, { key: 'a', code: 'KeyA', alt: true })).toBe(
      false
    )
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  it('leaves an explicit AltGraph chord in the guest', () => {
    withPlatform('darwin', () => {
      const { context, event, send } = fixture()
      context.getKeybindings = () => ({ 'view.plugins': ['Cmd+Alt+Q'] })
      const input = { key: 'q', code: 'KeyQ', meta: true, alt: true }
      expect(forwardGuestShortcutInput(context, event, { ...input, altGraph: true })).toBe(false)
      expect(
        forwardGuestShortcutInput(context, event, {
          ...input,
          getModifierState: (key) => key === 'AltGraph'
        })
      ).toBe(false)
      expect(event.preventDefault).not.toHaveBeenCalled()
      expect(send).not.toHaveBeenCalled()
    })
  })

  it.each(['win32', 'linux'] as const)(
    'leaves Electron Ctrl+Alt input to the page on %s',
    (platform) => {
      withPlatform(platform, () => {
        const { context, event, send } = fixture()
        context.getKeybindings = () => ({ 'view.plugins': ['Ctrl+Alt+Q'] })
        const input = { key: 'q', code: 'KeyQ', control: true, alt: true }
        expect(forwardGuestShortcutInput(context, event, { ...input, altGraph: true })).toBe(false)
        expect(forwardGuestShortcutInput(context, event, input)).toBe(false)
        expect(event.preventDefault).not.toHaveBeenCalled()
        expect(send).not.toHaveBeenCalled()
      })
    }
  )

  it('opens from the default macOS chord when Option turns X into a symbol, not when it is a dead key', () => {
    withPlatform('darwin', () => {
      const { context, event, send } = fixture()
      context.getKeybindings = () => ({})
      const chord = { code: 'KeyX', meta: true, alt: true }
      expect(forwardGuestShortcutInput(context, event, { ...chord, key: 'Dead' })).toBe(false)
      expect(send).not.toHaveBeenCalled()
      expect(forwardGuestShortcutInput(context, event, { ...chord, key: '≈' })).toBe(true)
      expect(send).toHaveBeenCalledWith(
        'ui:browserPageTabShortcut',
        expect.objectContaining({ key: '≈', code: 'KeyX', meta: true, alt: true })
      )
    })
  })

  it('follows the typed letter on a German layout where Y and Z swap keys on Linux', () => {
    withPlatform('linux', () => {
      const { context, event, send } = fixture()
      context.getKeybindings = () => ({})
      const chord = { control: true, shift: true }
      expect(forwardGuestShortcutInput(context, event, { ...chord, key: 'Z', code: 'KeyY' })).toBe(
        false
      )
      expect(send).not.toHaveBeenCalled()
      expect(forwardGuestShortcutInput(context, event, { ...chord, key: 'Y', code: 'KeyZ' })).toBe(
        true
      )
      expect(send).toHaveBeenCalledOnce()
    })
  })

  it('replays a configured modifier double tap', () => {
    const { context, event, send } = fixture()
    context.getKeybindings = () => ({ 'view.plugins': ['DoubleTap+Mod'] })
    expect(forwardGuestShortcutInput(context, event, { doubleTapModifier: primaryDoubleTap })).toBe(
      true
    )
    expect(send).toHaveBeenCalledWith(
      'ui:browserPageTabShortcut',
      expect.objectContaining({ doubleTapModifier: primaryDoubleTap })
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
