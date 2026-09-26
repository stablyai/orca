import {
  isRecentTabSwitcherCommitRelease,
  matchesRecentTabSwitcherChord,
  nativeZoomCommandMatchesKeybindings,
  resolveWindowShortcutAction
} from '../../shared/window-shortcut-policy'
import type { KeybindingOverrides } from '../../shared/keybindings'
import type { BrowserPageZoomDirection } from '../../shared/browser-page-zoom'
import {
  ModifierDoubleTapDetector,
  toModifierDoubleTapEvent
} from '../../shared/modifier-double-tap-detector'
import type { ResolveRenderer } from './browser-guest-renderer-target'
import { consumeRecentGuestWheelZoom } from './browser-guest-wheel-zoom'
import {
  forwardGuestShortcutInput,
  type GuestShortcutForwardContext,
  type GuestShortcutInput,
  type IsMobileEmulatorEnabled,
  type ShouldForwardDictationShortcut
} from './browser-guest-shortcut-dispatch'

/** Bridges guest input that cannot reach the host renderer; returns listener cleanup. */
export function setupGuestShortcutForwarding(args: {
  browserTabId: string
  guest: Electron.WebContents
  resolveRenderer: ResolveRenderer
  shouldForwardDictationShortcut?: ShouldForwardDictationShortcut
  isMobileEmulatorEnabled?: IsMobileEmulatorEnabled
  getKeybindings?: () => KeybindingOverrides | undefined
  // Why: a floating-panel guest owns a distinct workspace; its close/index chords must route to the panel, not the main tab strip.
  resolveWorktreeId?: (browserTabId: string) => string | null
  resolveWorkspaceId?: (browserTabId: string) => string | null
}): () => void {
  const {
    browserTabId,
    guest,
    resolveRenderer,
    shouldForwardDictationShortcut,
    isMobileEmulatorEnabled,
    getKeybindings,
    resolveWorktreeId,
    resolveWorkspaceId
  } = args
  let ctrlTabSwitching = false
  const doubleTapDetector = new ModifierDoubleTapDetector()
  const resetDoubleTapDetector = (): void => doubleTapDetector.reset()
  /** Sends the registered page ID so the renderer can resolve its current owning split. */
  const notifyGuestInteraction = (): void => {
    resolveRenderer(browserTabId)?.send('ui:browserGuestInteraction', browserTabId)
  }
  /** Claims split focus on presses, leaving hover and scrolling free of focus changes. */
  const mouseHandler = (_event: Electron.Event, input: Electron.MouseInputEvent): void => {
    if (input.type === 'mouseDown') {
      notifyGuestInteraction()
    }
  }

  const forwardBrowserPageZoom = (
    event: Electron.Event,
    direction: BrowserPageZoomDirection
  ): void => {
    event.preventDefault()
    const renderer = resolveRenderer(browserTabId)
    renderer?.send('ui:zoomBrowserPage', { browserPageId: browserTabId, direction })
  }

  const forwardContext: GuestShortcutForwardContext = {
    browserTabId,
    resolveRenderer,
    shouldForwardDictationShortcut,
    isMobileEmulatorEnabled,
    getKeybindings,
    resolveWorktreeId,
    resolveWorkspaceId,
    forwardBrowserPageZoom
  }

  /** Reports split ownership before forwarding shortcuts from a separate guest process. */
  const handler = (event: Electron.Event, input: Electron.Input): void => {
    if (input.type === 'keyDown') {
      notifyGuestInteraction()
    }
    const keybindings = getKeybindings?.()
    if (
      input.type === 'keyDown' &&
      matchesRecentTabSwitcherChord(input, process.platform, keybindings)
    ) {
      // Why: held switcher commits on Control keyup; preventDefault on Tab
      // keydown suppresses that keyup in Electron and strands the overlay.
      ctrlTabSwitching = true
      const renderer = resolveRenderer(browserTabId)
      renderer?.send('ui:ctrlTabKeyDown', { shiftKey: input.shift === true })
      return
    }

    if (ctrlTabSwitching && isRecentTabSwitcherCommitRelease(input)) {
      event.preventDefault()
      ctrlTabSwitching = false
      const renderer = resolveRenderer(browserTabId)
      renderer?.send('ui:ctrlTabKeyUp')
      return
    }

    if (input.type === 'keyDown' || input.type === 'keyUp') {
      const detected = doubleTapDetector.process(
        toModifierDoubleTapEvent({
          type: input.type,
          code: input.code,
          key: input.key,
          shift: input.shift,
          control: input.control,
          alt: input.alt,
          meta: input.meta,
          isAutoRepeat: input.isAutoRepeat
        }),
        Date.now()
      )
      if (detected) {
        const doubleTapInput: GuestShortcutInput = { doubleTapModifier: detected.modifier }
        forwardGuestShortcutInput(
          forwardContext,
          event,
          doubleTapInput,
          resolveWindowShortcutAction(doubleTapInput, process.platform, keybindings, {
            context: 'app'
          })
        )
        return
      }
    }

    if (input.type !== 'keyDown') {
      return
    }
    // Why: Cmd/Ctrl+Alt+Arrow is the only allowlisted chord carrying Alt, so resolve it before the Alt-rejecting chord gate below.
    const action = resolveWindowShortcutAction(input, process.platform, keybindings)
    forwardGuestShortcutInput(forwardContext, event, input, action)
  }

  const zoomCommandHandler = (
    event: Electron.Event,
    zoomDirection: 'in' | 'out' | 'reset'
  ): void => {
    if (zoomDirection !== 'in' && zoomDirection !== 'out') {
      return
    }
    // Why: some layouts/platforms turn Ctrl/Cmd +/- into Electron's native zoom before before-input-event reaches the guest.
    if (consumeRecentGuestWheelZoom(guest, zoomDirection)) {
      event.preventDefault()
      return
    }
    if (!nativeZoomCommandMatchesKeybindings(zoomDirection, process.platform, getKeybindings?.())) {
      return
    }
    forwardBrowserPageZoom(event, zoomDirection)
  }

  guest.on('before-input-event', handler)
  guest.on('before-mouse-event', mouseHandler)
  guest.on('zoom-changed', zoomCommandHandler)
  guest.on('blur', resetDoubleTapDetector)
  return () => {
    try {
      guest.off('before-input-event', handler)
      guest.off('before-mouse-event', mouseHandler)
      guest.off('zoom-changed', zoomCommandHandler)
      guest.off('blur', resetDoubleTapDetector)
    } catch {
      // Why: best-effort — guest may already be destroyed during teardown.
    }
  }
}
