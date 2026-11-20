import {
  GRAB_NATIVE_KEY_POLICY,
  GRAB_NATIVE_KEY_REPORT,
  GRAB_CHORD_POLICY,
  GRAB_CHORD_REPORT,
  guestFocusTakesTyping,
  type GrabChordPolicy,
  type GrabNativeKeyPolicy
} from '../../../shared/browser/element-grab/browser-grab-native-keys'
import { keybindingMatchesInput } from '../../../shared/keybindings/matching'
import {
  browserGuestToolKeyFromEvent,
  isBrowserGuestToolKey,
  isBrowserGrabActionKey
} from '../../../shared/browser/element-grab/browser-grab-types'

/** Installed before page scripts so eligible letters are consumed without replaying native input. */
export function installBrowserGuestNativeToolKeys(port: {
  on: (channel: string, listener: (payload: unknown) => void) => void
  send: (channel: string, payload: unknown) => void
}): void {
  let policy: GrabNativeKeyPolicy | null = null
  let chord: GrabChordPolicy | null = null
  port.on(GRAB_CHORD_POLICY, (payload) => {
    if (
      !payload ||
      typeof payload !== 'object' ||
      !('token' in payload) ||
      typeof payload.token !== 'string' ||
      !('revision' in payload) ||
      typeof payload.revision !== 'number' ||
      !('enabled' in payload) ||
      typeof payload.enabled !== 'boolean' ||
      !('bindings' in payload) ||
      !Array.isArray(payload.bindings) ||
      !payload.bindings.every((key) => typeof key === 'string') ||
      !('platform' in payload) ||
      !['darwin', 'linux', 'win32'].includes(String(payload.platform))
    ) {
      return
    }
    chord = {
      token: payload.token,
      revision: payload.revision,
      enabled: payload.enabled,
      bindings: payload.bindings,
      platform:
        payload.platform === 'darwin' ? 'darwin' : payload.platform === 'win32' ? 'win32' : 'linux'
    }
    port.send(GRAB_CHORD_REPORT, { token: chord.token, revision: chord.revision, ready: true })
  })
  port.on(GRAB_NATIVE_KEY_POLICY, (payload) => {
    if (
      !payload ||
      typeof payload !== 'object' ||
      !('token' in payload) ||
      !('revision' in payload) ||
      !('enabled' in payload) ||
      typeof payload.token !== 'string' ||
      typeof payload.revision !== 'number' ||
      typeof payload.enabled !== 'boolean'
    ) {
      return
    }
    policy = { token: payload.token, revision: payload.revision, enabled: payload.enabled }
    port.send(GRAB_NATIVE_KEY_REPORT, { ...policy, ready: true })
  })
  window.addEventListener(
    'keydown',
    (event) => {
      const currentChord = chord
      if (
        currentChord?.enabled &&
        event.isTrusted &&
        !event.repeat &&
        !event.isComposing &&
        event.keyCode !== 229 &&
        !event.getModifierState('AltGraph') &&
        !guestFocusTakesTyping() &&
        !/^(Alt|Control|Meta|Shift)$/.test(event.key)
      ) {
        const input = {
          key: event.key,
          code: event.code,
          control: event.ctrlKey,
          meta: event.metaKey,
          alt: event.altKey,
          shift: event.shiftKey
        }
        const selection = window.getSelection()
        if (
          !(selection?.type === 'Range' && selection.toString().trim()) &&
          currentChord.bindings.some((binding) =>
            keybindingMatchesInput(binding, input, currentChord.platform)
          )
        ) {
          event.preventDefault()
          event.stopImmediatePropagation()
          port.send(GRAB_CHORD_REPORT, {
            token: currentChord.token,
            revision: currentChord.revision,
            input
          })
          return
        }
      }
      if (
        !policy?.enabled ||
        !event.isTrusted ||
        event.isComposing ||
        event.keyCode === 229 ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        event.shiftKey ||
        event.getModifierState('AltGraph') ||
        guestFocusTakesTyping()
      ) {
        return
      }
      const key = browserGuestToolKeyFromEvent(event)
      if (!isBrowserGuestToolKey(key)) {
        return
      }
      event.preventDefault()
      event.stopImmediatePropagation()
      if (!event.repeat || isBrowserGrabActionKey(key)) {
        port.send(GRAB_NATIVE_KEY_REPORT, { token: policy.token, revision: policy.revision, key })
      }
    },
    true
  )
}
