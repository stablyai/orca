import {
  keybindingMatchesAction,
  type KeybindingInput,
  type KeybindingOverrides
} from '../../shared/keybindings'

const installedDevTools = new WeakSet<Electron.WebContents>()

// input-event is typed as the generic InputEvent, but key events carry key/code at runtime.
function readKeyDownInput(input: Electron.InputEvent): KeybindingInput | null {
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

// Why: the app menu has no close role (main-window Cmd/Ctrl+W closes Orca tabs), so a detached
// guest DevTools window has nothing handling the close chord unless its webContents claims it.
export function installGuestDevToolsCloseShortcut(
  guest: Electron.WebContents,
  getKeybindings: () => KeybindingOverrides | undefined
): void {
  const install = (): void => {
    const devTools = guest.devToolsWebContents
    if (!devTools || devTools.isDestroyed() || installedDevTools.has(devTools)) {
      return
    }
    installedDevTools.add(devTools)
    // Why input-event: Electron never emits before-input-event for DevTools webContents.
    // The listener dies with the DevTools webContents, which is destroyed on close.
    devTools.on('input-event', (_event, inputEvent) => {
      const input = readKeyDownInput(inputEvent)
      if (!input) {
        return
      }
      if (!keybindingMatchesAction('tab.close', input, process.platform, getKeybindings())) {
        return
      }
      // Why deferred: AppKit is still routing this key through the DevTools view; destroying
      // it synchronously segfaults in performKeyEquivalent.
      setImmediate(() => {
        if (!guest.isDestroyed()) {
          guest.closeDevTools()
        }
      })
    })
  }
  if (guest.isDevToolsOpened() && guest.devToolsWebContents) {
    install()
    return
  }
  guest.once('devtools-opened', install)
}
