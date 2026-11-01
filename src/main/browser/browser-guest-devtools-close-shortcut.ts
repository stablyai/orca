import {
  keybindingMatchesAction,
  type KeybindingInput,
  type KeybindingOverrides
} from '../../shared/keybindings'

/** Cmd/Ctrl+W in a page's DevTools, docked or in their own window, closes DevTools, not the tab. */
export function installGuestDevToolsCloseShortcut(args: {
  guest: Electron.WebContents
  getKeybindings: () => KeybindingOverrides | undefined
  closeDevTools: () => void
}): () => void {
  const { guest, getKeybindings, closeDevTools } = args
  const handleOpened = (): void => {
    const devTools = guest.devToolsWebContents
    if (devTools && !devTools.isDestroyed()) {
      installCloseShortcut(guest, devTools, getKeybindings, closeDevTools)
    }
  }
  guest.on('devtools-opened', handleOpened)
  return () => {
    try {
      guest.off('devtools-opened', handleOpened)
    } catch {
      // guest may already be destroyed
    }
  }
}

// input-event is typed as the generic InputEvent, but key events carry key/code at runtime.
export function readDevToolsShortcutInput(input: Electron.InputEvent): KeybindingInput | null {
  const modifiers = input.modifiers ?? []
  if (input.type !== 'rawKeyDown' || modifiers.includes('isautorepeat')) {
    return null
  }
  if (!('key' in input) || typeof input.key !== 'string') {
    return null
  }
  return {
    key: input.key,
    code: 'code' in input && typeof input.code === 'string' ? input.code : undefined,
    meta: modifiers.includes('meta'),
    control: modifiers.includes('control'),
    alt: modifiers.includes('alt'),
    shift: modifiers.includes('shift')
  }
}

function installCloseShortcut(
  guest: Electron.WebContents,
  devTools: Electron.WebContents,
  getKeybindings: () => KeybindingOverrides | undefined,
  closeDevTools: () => void
): void {
  // DevTools emits input-event, not before-input-event; closing it also destroys this listener.
  devTools.on('input-event', (_event, inputEvent) => {
    const input = readDevToolsShortcutInput(inputEvent)
    if (
      !input ||
      !keybindingMatchesAction('tab.close', input, process.platform, getKeybindings())
    ) {
      return
    }
    // Defer closing until AppKit finishes routing the key to avoid a performKeyEquivalent crash.
    setImmediate(() => {
      if (!guest.isDestroyed()) {
        closeDevTools()
      }
    })
  })
}
