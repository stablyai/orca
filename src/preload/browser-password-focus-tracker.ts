/**
 * Reports where a focused credential field sits so Orca can anchor its dropdown, and hides the
 * dropdown the moment that position could be stale (blur, scroll, resize).
 */
import type {
  BrowserPasswordFieldRole,
  BrowserPasswordGuestFieldBlurred,
  BrowserPasswordGuestFieldFocused
} from '../shared/browser-passwords-types'
import { PRELOAD_BROWSER_PASSWORDS_GUEST_CHANNELS } from './browser-password-guest-channels'
import type { BrowserPasswordGuestPort } from './browser-password-guest-port'
import {
  fieldRoleOf,
  inputFromEvent,
  type BrowserPasswordFormScanner
} from './browser-password-form-scan'

export type BrowserPasswordFocusTracker = {
  onFocusIn: (event: Event) => void
  onFocusOut: (event: Event) => void
  /** Hides the dropdown, e.g. after a fill moved focus while focus reports were muted. */
  clear: () => void
}

type FocusTrackerContext = {
  port: BrowserPasswordGuestPort
  scanner: BrowserPasswordFormScanner
  tokenFor: (input: HTMLInputElement) => string
  /** True while the detector itself moves focus during a fill. */
  isMuted: () => boolean
}

// Why: focusing an off-screen field scrolls it into view; that scroll repositions, not hides.
const FOCUS_SCROLL_GRACE_MS = 250
const VIEWPORT_LISTENER_OPTIONS = { capture: true, passive: true } as const

type FocusedField = {
  input: HTMLInputElement
  fieldToken: string
  formSignature: string
  role: BrowserPasswordFieldRole
  focusedAt: number
}

export function createBrowserPasswordFocusTracker(
  context: FocusTrackerContext
): BrowserPasswordFocusTracker {
  let focused: FocusedField | null = null

  const sendFocused = (field: FocusedField): void => {
    const box = field.input.getBoundingClientRect()
    const payload: BrowserPasswordGuestFieldFocused = {
      fieldToken: field.fieldToken,
      formSignature: field.formSignature,
      role: field.role,
      rect: { x: box.x, y: box.y, width: box.width, height: box.height },
      viewportWidth: window.innerWidth
    }
    context.port.send(PRELOAD_BROWSER_PASSWORDS_GUEST_CHANNELS.fieldFocused, payload)
  }

  const clear = (): void => {
    if (!focused) {
      return
    }
    const payload: BrowserPasswordGuestFieldBlurred = { fieldToken: focused.fieldToken }
    focused = null
    window.removeEventListener('scroll', onViewportChange, VIEWPORT_LISTENER_OPTIONS)
    window.removeEventListener('resize', onViewportChange, VIEWPORT_LISTENER_OPTIONS)
    context.port.send(PRELOAD_BROWSER_PASSWORDS_GUEST_CHANNELS.fieldBlurred, payload)
  }

  function onViewportChange(): void {
    if (focused && Date.now() - focused.focusedAt < FOCUS_SCROLL_GRACE_MS) {
      sendFocused(focused)
      return
    }
    clear()
  }

  return {
    onFocusIn(event) {
      if (!event.isTrusted || context.isMuted()) {
        return
      }
      const input = inputFromEvent(event)
      const form = input ? context.scanner.scanFormOf(input) : null
      const role = input && form ? fieldRoleOf(form, input) : null
      // Saved logins would be the wrong offer on a form that creates an account.
      if (!input || !form || !role || form.parsed.kind === 'signup') {
        return
      }
      if (focused && focused.input !== input) {
        clear()
      }
      if (!focused) {
        window.addEventListener('scroll', onViewportChange, VIEWPORT_LISTENER_OPTIONS)
        window.addEventListener('resize', onViewportChange, VIEWPORT_LISTENER_OPTIONS)
      }
      focused = {
        input,
        fieldToken: context.tokenFor(input),
        formSignature: form.signature,
        role,
        focusedAt: Date.now()
      }
      sendFocused(focused)
    },
    onFocusOut(event) {
      // Why no trust check: hiding the dropdown is always safe, whoever asks.
      if (!context.isMuted() && focused && inputFromEvent(event) === focused.input) {
        clear()
      }
    },
    clear
  }
}
