import { keybindingMatchesAction, type KeybindingOverrides } from '../../shared/keybindings'
import type { ResolveRenderer } from './browser-guest-renderer-target'

export type GrabShortcutContext = {
  browserTabId: string
  guest: Electron.WebContents
  resolveRenderer: ResolveRenderer
  hasActiveGrabOp: (browserTabId: string) => boolean
  getKeybindings?: () => KeybindingOverrides | undefined
}

type GrabShortcutInput = Pick<
  Electron.Input,
  'type' | 'key' | 'code' | 'meta' | 'control' | 'alt' | 'shift' | 'isAutoRepeat'
>

/**
 * Handles a key typed into a browser page that may be a grab gesture. Returns true when the key
 * belongs to Orca and must not reach the page (bare C/S during an active grab pick).
 */
export function handleGrabShortcutInput(
  ctx: GrabShortcutContext,
  input: GrabShortcutInput,
  claimToggle?: () => void
): boolean {
  const { browserTabId, guest, resolveRenderer, hasActiveGrabOp, getKeybindings } = ctx
  if (input.type !== 'keyDown') {
    return false
  }
  const bareKey = input.key.toLowerCase()
  if (
    !input.meta &&
    !input.control &&
    !input.alt &&
    !input.shift &&
    (bareKey === 'c' || bareKey === 's') &&
    hasActiveGrabOp(browserTabId)
  ) {
    const renderer = resolveRenderer(browserTabId)
    if (!renderer) {
      return false
    }
    // Why: a focused guest swallows bare keys; during an active grab pick, plain C/S are Orca's copy/screenshot, not page typing.
    renderer.send('browser:grabActionShortcut', { browserPageId: browserTabId, key: bareKey })
    return true
  }

  if (
    // Why: the renderer toggles the picker per message, so a held chord would flicker it.
    input.isAutoRepeat ||
    !keybindingMatchesAction('browser.grabElement', input, process.platform, getKeybindings?.())
  ) {
    return false
  }

  void guest
    .executeJavaScript(`(() => {
      const active = document.activeElement
      const tag = active?.tagName
      const isEditable =
        active instanceof HTMLInputElement ||
        active instanceof HTMLTextAreaElement ||
        active?.isContentEditable === true ||
        tag === 'SELECT' ||
        tag === 'IFRAME'
      if (isEditable) {
        return false
      }
      const selection = window.getSelection()
      return Boolean(selection && selection.type === 'Range' && selection.toString().trim().length > 0)
        ? false
        : true
    })()`)
    .then((shouldToggle) => {
      if (shouldToggle) {
        claimToggle?.()
        resolveRenderer(browserTabId)?.send('browser:grabModeToggle', browserTabId, 'copy')
      }
    })
    .catch(() => {
      // Why: shortcut forwarding is best-effort — guest teardown or a transient executeJavaScript failure must not break normal copy.
    })
  return false
}

// Why: a focused guest never surfaces Cmd/Ctrl+C to the renderer; forward only when it wouldn't do a normal copy (no editable focus, no selection).
export function setupGrabShortcutForwarding(args: GrabShortcutContext): () => void {
  const { guest } = args
  const handler = (event: Electron.Event, input: Electron.Input): void => {
    if (handleGrabShortcutInput(args, input, () => event.preventDefault())) {
      event.preventDefault()
    }
  }

  guest.on('before-input-event', handler)
  return () => {
    try {
      guest.off('before-input-event', handler)
    } catch {
      // Why: browser tabs can briefly outlive the guest webContents during teardown, so cleanup is best-effort.
    }
  }
}
