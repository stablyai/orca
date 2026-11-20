import { keybindingMatchesAction } from '../../../../../shared/keybindings/matching'
import type { KeybindingOverrides } from '../../../../../shared/keybindings/types'
import { isAgentInjectingInput } from '../../../cdp/input/agent-input-injection'
import {
  browserGuestToolKeyFromEvent,
  isBrowserGrabActionKey,
  isBrowserGuestToolKey
} from '../../../../../shared/browser/element-grab/browser-grab-types'
import type { ResolveRenderer } from '../../browser-guest-renderer-target'
import { GuestKeyHold, type HeldKeyInput } from './guest-key-hold'

// Guests swallow renderer shortcuts; keep normal copy when editing or text is selected.
export function setupGrabShortcutForwarding(args: {
  browserTabId: string
  guest: Electron.WebContents
  resolveRenderer: ResolveRenderer
  hasActiveGrabOp: (browserTabId: string) => boolean
  /** True while a page field (input, editor, frame) has focus during a pick: its typing stays with the page. */
  isGuestEditableFocused?: (browserTabId: string) => boolean
  /** Tab moved focus in the page; the field state is unknown (treated as a field) until the page reports. */
  markGuestFocusUnknown?: (browserTabId: string) => void
  /** Asks the page directly whether a field has focus now (its last report may lag a focus move). */
  askPageHasField?: (browserTabId: string) => Promise<boolean>
  getKeybindings?: () => KeybindingOverrides | undefined
}): () => void {
  const { browserTabId, guest, resolveRenderer, hasActiveGrabOp, getKeybindings } = args
  const isGuestEditableFocused = args.isGuestEditableFocused ?? (() => false)
  // Electron's input carries no AltGraph flag; the AltGr key reports itself, so its own edges say when it is held.
  // Its release can happen elsewhere (another window, the app), so it is forgotten when the page loses focus and
  // whenever a pick starts or ends; a stale flag would only leave letters to the page.
  let altGraphHeld = false
  let pickWasActive = false
  const forgetAltGraph = (): void => {
    altGraphHeld = false
  }
  const isToolKeyDown = (input: HeldKeyInput): boolean =>
    input.type === 'keyDown' &&
    !input.meta &&
    !input.control &&
    !input.alt &&
    !input.shift &&
    // An IME composition owns its keys, and so does AltGr's layer of characters.
    !input.isComposing &&
    !altGraphHeld &&
    isBrowserGuestToolKey(browserGuestToolKeyFromEvent(input)) &&
    hasActiveGrabOp(browserTabId)
  // During a grab, bare C/S copy or screenshot and A/G/D switch tools instead of typing into the page.
  const takeAsTool = (
    input: Pick<
      Electron.Input,
      'key' | 'isAutoRepeat' | 'type' | 'shift' | 'control' | 'alt' | 'meta'
    > & { code?: string }
  ): void => {
    const bareKey = browserGuestToolKeyFromEvent(input)
    // A held tool key would switch on every repeat; swallowing it is enough.
    if (
      !isBrowserGuestToolKey(bareKey) ||
      (input.isAutoRepeat && !isBrowserGrabActionKey(bareKey))
    ) {
      return
    }
    resolveRenderer(browserTabId)?.send('browser:grabActionShortcut', {
      browserPageId: browserTabId,
      key: bareKey
    })
  }
  const askPageHasField = args.askPageHasField ?? (async () => true)
  const hold = new GuestKeyHold(
    guest,
    () => askPageHasField(browserTabId),
    isToolKeyDown,
    takeAsTool
  )
  const handler = (event: Electron.Event, input: Electron.Input): void => {
    // Agent-injected keys must not trigger Orca actions (#20595).
    if (isAgentInjectingInput(guest)) {
      return
    }
    // A key the hold sent back into the page: it was already decided.
    if (hold.consumeReplay()) {
      return
    }
    const pickActive = hasActiveGrabOp(browserTabId)
    if (pickActive !== pickWasActive) {
      pickWasActive = pickActive
      altGraphHeld = false
      // The pick ended while keys waited: they were typed for the page.
      if (!pickActive) {
        hold.release()
      }
    }
    // Keys typed while a letter waits for the page's answer queue behind it, so nothing is reordered.
    if (hold.holding) {
      event.preventDefault()
      hold.add(input)
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
    if (input.key === 'Tab' && pickActive) {
      args.markGuestFocusUnknown?.(browserTabId)
      return
    }
    if (isToolKeyDown(input)) {
      // A field has (or may have) focus: the letter types there.
      if (isGuestEditableFocused(browserTabId) || !resolveRenderer(browserTabId)) {
        return
      }
      // Last report says no field, but focus may have just moved: ask the page before taking the letter.
      event.preventDefault()
      hold.start(input)
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
  guest.on('blur', forgetAltGraph)
  return () => {
    try {
      guest.off('before-input-event', handler)
      guest.off('blur', forgetAltGraph)
    } catch {
      // The guest may already be destroyed.
    }
  }
}
