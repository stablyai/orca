import { executeGrabScript } from '../../../element-grab/grab-guest-execution'
import { guestFocusTakesTyping } from '../../../../../shared/browser/element-grab/browser-grab-native-keys'
import { keybindingMatchesAction } from '../../../../../shared/keybindings/matching'
import type { KeybindingOverrides } from '../../../../../shared/keybindings/types'
import { isAgentInjectingInput } from '../../../cdp/input/agent-input-injection'
import type { ResolveRenderer } from '../../browser-guest-renderer-target'

// Guests swallow renderer shortcuts; keep normal copy when editing or text is selected.
export function setupGrabShortcutForwarding(args: {
  browserTabId: string
  guest: Electron.WebContents
  resolveRenderer: ResolveRenderer
  hasActiveGrabOp: (browserTabId: string) => boolean
  getKeybindings?: () => KeybindingOverrides | undefined
}): () => void {
  const { browserTabId, guest, resolveRenderer, hasActiveGrabOp, getKeybindings } = args
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
    if (
      // Repeating a toggle would flicker the picker.
      input.isAutoRepeat ||
      !keybindingMatchesAction('browser.grabElement', input, process.platform, getKeybindings?.())
    ) {
      return
    }

    const destination = resolveRenderer(browserTabId)
    void executeGrabScript(guest, () =>
      guest.executeJavaScriptInIsolatedWorld(1_209, [
        {
          code: `(() => {
      if ((${guestFocusTakesTyping.toString()})()) return false
      const selection = window.getSelection()
      return !(selection && selection.type === 'Range' && selection.toString().trim().length > 0)
    })()`
        }
      ])
    )
      .then((shouldToggle) => {
        if (!shouldToggle || !destination || resolveRenderer(browserTabId) !== destination) {
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
    guest.off('before-input-event', handler)
  }
}
