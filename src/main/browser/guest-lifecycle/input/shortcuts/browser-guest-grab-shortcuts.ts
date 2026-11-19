import { keybindingMatchesAction } from '../../../../../shared/keybindings/matching'
import type { KeybindingOverrides } from '../../../../../shared/keybindings/types'
import { isAgentInjectingInput } from '../../../cdp/input/agent-input-injection'
import {
  browserGuestToolKeyFromEvent,
  isBrowserGrabActionKey,
  isBrowserGuestToolKey
} from '../../../../../shared/browser/element-grab/browser-grab-types'
import type { ResolveRenderer } from '../../browser-guest-renderer-target'

// Guests swallow renderer shortcuts; keep normal copy when editing or text is selected.
export function setupGrabShortcutForwarding(args: {
  browserTabId: string
  guest: Electron.WebContents
  resolveRenderer: ResolveRenderer
  hasActiveGrabOp: (browserTabId: string) => boolean
  /** True while a page field (input, editor, frame) has focus during a pick: its typing stays with the page. */
  isGuestEditableFocused?: (browserTabId: string) => boolean
  getKeybindings?: () => KeybindingOverrides | undefined
}): () => void {
  const { browserTabId, guest, resolveRenderer, hasActiveGrabOp, getKeybindings } = args
  const isGuestEditableFocused = args.isGuestEditableFocused ?? (() => false)
  // Electron's input carries no AltGraph flag; the AltGr key reports itself, so its own edges say when it is held.
  let altGraphHeld = false
  const handler = (event: Electron.Event, input: Electron.Input): void => {
    // Agent-injected keys must not trigger Orca actions (#20595).
    if (isAgentInjectingInput(guest)) {
      return
    }
    // Alt alone, held over the page while picking, fades the palette so what's under it can be picked. The page
    // still receives Alt; only its up/down edges are mirrored.
    if (input.key === 'Alt' && !input.isAutoRepeat) {
      // Key-up is always sent: Alt can go down in the app or during a pick that has since ended, and a release the
      // renderer never hears leaves the palette faded. A renderer that isn't fading ignores it.
      const shouldMirror = input.type === 'keyUp' || hasActiveGrabOp(browserTabId)
      if (shouldMirror) {
        resolveRenderer(browserTabId)?.send('browser:grabActionShortcut', {
          browserPageId: browserTabId,
          key: input.type === 'keyDown' ? 'alt-down' : 'alt-up'
        })
      }
      return
    }
    if (input.key === 'AltGraph') {
      altGraphHeld = input.type === 'keyDown'
      return
    }
    if (input.type !== 'keyDown') {
      return
    }
    const bareKey = browserGuestToolKeyFromEvent(input)
    if (
      !input.meta &&
      !input.control &&
      !input.alt &&
      !input.shift &&
      // An IME composition owns its keys, and so does AltGr's layer of characters.
      !input.isComposing &&
      !altGraphHeld &&
      isBrowserGuestToolKey(bareKey) &&
      hasActiveGrabOp(browserTabId) &&
      !isGuestEditableFocused(browserTabId)
    ) {
      const renderer = resolveRenderer(browserTabId)
      if (!renderer) {
        return
      }
      // During a grab, bare C/S copy or screenshot and A/G/D switch tools instead of typing into the page.
      event.preventDefault()
      // A held tool key would switch on every repeat; swallowing it is enough.
      if (input.isAutoRepeat && !isBrowserGrabActionKey(bareKey)) {
        return
      }
      renderer.send('browser:grabActionShortcut', { browserPageId: browserTabId, key: bareKey })
      return
    }

    if (
      // Repeating a toggle would flicker the picker.
      input.isAutoRepeat ||
      !keybindingMatchesAction('browser.grabElement', input, process.platform, getKeybindings?.())
    ) {
      return
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
        if (!shouldToggle) {
          return
        }
        event.preventDefault()
        const renderer = resolveRenderer(browserTabId)
        if (!renderer) {
          return
        }
        renderer.send('browser:grabModeToggle', browserTabId, 'copy')
      })
      .catch(() => {
        // Guest teardown or script failure must not interrupt normal copy.
      })
  }

  guest.on('before-input-event', handler)
  return () => {
    try {
      guest.off('before-input-event', handler)
    } catch {
      // The guest may already be destroyed.
    }
  }
}
