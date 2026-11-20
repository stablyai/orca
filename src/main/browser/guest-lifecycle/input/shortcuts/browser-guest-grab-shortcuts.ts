import {
  GRAB_CHORD_POLICY,
  GRAB_CHORD_QUERY
} from '../../../../../shared/browser/element-grab/browser-grab-native-keys'
import { keybindingMatchesAction } from '../../../../../shared/keybindings/matching'
import type { KeybindingInput, KeybindingOverrides } from '../../../../../shared/keybindings/types'
import { isAgentInjectingInput } from '../../../cdp/input/agent-input-injection'
import type { ResolveRenderer } from '../../browser-guest-renderer-target'

type GrabShortcutBinding = {
  browserTabId: string
  guest: Electron.WebContents
  resolveRenderer: ResolveRenderer
  hasActiveGrabOp: (browserTabId: string) => boolean
  getKeybindings?: () => KeybindingOverrides | undefined
  isCurrentGuest?: () => boolean
}
const chordBindings = new WeakMap<Electron.WebContents, { current: GrabShortcutBinding | null }>()

// One synchronous private endpoint per guest; inactive registrations always answer without consuming input.
function bindChordQuery(args: GrabShortcutBinding): () => void {
  const guest = args.guest
  let state = chordBindings.get(guest)
  if (!state) {
    state = { current: null }
    chordBindings.set(guest, state)
    const binding = state
    const report = (
      event: Electron.IpcMainEvent,
      channel: string,
      input: KeybindingInput
    ): void => {
      if (channel !== GRAB_CHORD_QUERY) {
        return
      }
      let consumed = false
      try {
        const current = binding.current
        if (
          !current ||
          event.senderFrame !== guest.mainFrame ||
          isAgentInjectingInput(guest) ||
          current.isCurrentGuest?.() === false
        ) {
          return
        }
        const renderer = current.resolveRenderer(current.browserTabId)
        if (
          !renderer ||
          renderer.isDestroyed() ||
          !keybindingMatchesAction(
            'browser.grabElement',
            input,
            process.platform,
            current.getKeybindings?.()
          )
        ) {
          return
        }
        consumed = true
        renderer.send('browser:grabModeToggle', current.browserTabId, 'copy')
      } finally {
        event.returnValue = consumed
      }
    }
    const ready = (): void => {
      if (!guest.isDestroyed()) {
        guest.send(GRAB_CHORD_POLICY, Boolean(binding.current))
      }
    }
    guest.on('ipc-message-sync', report)
    guest.on('dom-ready', ready)
    guest.once('destroyed', () => {
      guest.off('ipc-message-sync', report)
      guest.off('dom-ready', ready)
      chordBindings.delete(guest)
    })
  }
  state.current = args
  guest.send(GRAB_CHORD_POLICY, true)
  return () => {
    if (state.current === args) {
      state.current = null
      if (!guest.isDestroyed()) {
        guest.send(GRAB_CHORD_POLICY, false)
      }
    }
  }
}

/** Guest keydown owns field/selection eligibility and cancels the chord before page/default dispatch. */
export function setupGrabShortcutForwarding(args: GrabShortcutBinding): () => void {
  const { browserTabId, guest, resolveRenderer, hasActiveGrabOp } = args
  const unbindChord = bindChordQuery(args)
  const handler = (_event: Electron.Event, input: Electron.Input): void => {
    if (isAgentInjectingInput(guest)) {
      return
    }
    if (input.key === 'Alt' && !input.isAutoRepeat) {
      if (input.type === 'keyUp' || hasActiveGrabOp(browserTabId)) {
        resolveRenderer(browserTabId)?.send('browser:grabActionShortcut', {
          browserPageId: browserTabId,
          key: input.type === 'keyDown' ? 'alt-down' : 'alt-up'
        })
      }
    }
  }
  guest.on('before-input-event', handler)
  return () => {
    unbindChord()
    guest.off('before-input-event', handler)
  }
}
