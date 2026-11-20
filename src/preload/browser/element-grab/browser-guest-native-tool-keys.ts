import {
  GRAB_NATIVE_KEY_POLICY,
  GRAB_NATIVE_KEY_REPORT,
  guestFocusTakesTyping,
  type GrabNativeKeyPolicy
} from '../../../shared/browser/element-grab/browser-grab-native-keys'
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
