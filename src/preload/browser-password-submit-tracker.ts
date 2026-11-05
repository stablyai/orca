/**
 * Turns the user's submit gestures into one `submitted` report each, then watches whether the
 * submitted form goes away (the in-page half of main's login-success decision).
 */
import type {
  BrowserPasswordGuestCapture,
  BrowserPasswordGuestFormGone,
  BrowserPasswordGuestSubmitted,
  BrowserPasswordSubmitSource
} from '../shared/browser-passwords-types'
import { PRELOAD_BROWSER_PASSWORDS_GUEST_CHANNELS } from './browser-password-guest-channels'
import type { BrowserPasswordGuestPort } from './browser-password-guest-port'
import {
  fieldRoleOf,
  formRootOf,
  inputFromEvent,
  isRenderedElement,
  type BrowserPasswordFormRoot,
  type BrowserPasswordFormScanner,
  type ScannedPasswordForm
} from './browser-password-form-scan'

export type BrowserPasswordSubmitTracker = {
  onSubmit: (event: Event) => void
  onKeyDown: (event: KeyboardEvent) => void
  onClick: (event: Event) => void
  /** Called after DOM mutations settle while a submitted form is being watched. */
  checkFormGone: () => void
}

type SubmitTrackerContext = {
  port: BrowserPasswordGuestPort
  scanner: BrowserPasswordFormScanner
  captureOf: (form: ScannedPasswordForm) => BrowserPasswordGuestCapture
  /** Sends any pending `typed` first, so main sees captures in the order the user made them. */
  flushTyped: () => void
}

const SUBMIT_CONTROL_SELECTOR =
  'button, input[type="submit"], input[type="button"], input[type="image"], [role="button"]'
const SUBMIT_WORDS_PATTERN =
  /sign.?in|log.?in|login|continue|next|submit|sign.?up|register|create|save|update|change/i
// Why: a click on a submit button also fires `submit`, and Enter fires the default button's click.
const SAME_GESTURE_MS = 1000

function submitControlText(control: Element): string {
  const value = control instanceof HTMLInputElement ? control.value : ''
  return [
    control instanceof HTMLInputElement ? '' : (control.textContent ?? '').slice(0, 100),
    value,
    control.getAttribute('aria-label') ?? '',
    control.id,
    control.getAttribute('name') ?? ''
  ].join(' ')
}

function findSubmitControl(event: Event): Element | null {
  for (const node of event.composedPath()) {
    if (node instanceof Element && node.matches(SUBMIT_CONTROL_SELECTOR)) {
      return SUBMIT_WORDS_PATTERN.test(submitControlText(node)) ? node : null
    }
  }
  return null
}

function hasTypedValue(capture: BrowserPasswordGuestCapture): boolean {
  return capture.username !== null || capture.password !== null || capture.newPassword !== null
}

export function createBrowserPasswordSubmitTracker(
  context: SubmitTrackerContext
): BrowserPasswordSubmitTracker {
  let lastGesture: { signature: string; values: string; at: number } | null = null
  let watched: {
    root: BrowserPasswordFormRoot
    signature: string
    fields: HTMLInputElement[]
  } | null = null

  const report = (form: ScannedPasswordForm, source: BrowserPasswordSubmitSource): void => {
    context.flushTyped()
    const capture = context.captureOf(form)
    if (!hasTypedValue(capture)) {
      return
    }
    const values = JSON.stringify([capture.username, capture.password, capture.newPassword])
    const now = Date.now()
    if (
      lastGesture?.signature === form.signature &&
      lastGesture.values === values &&
      now - lastGesture.at < SAME_GESTURE_MS
    ) {
      return
    }
    lastGesture = { signature: form.signature, values, at: now }
    const payload: BrowserPasswordGuestSubmitted = { ...capture, source }
    context.port.send(PRELOAD_BROWSER_PASSWORDS_GUEST_CHANNELS.submitted, payload)
    const { parsed } = form
    watched = {
      root: form.root,
      signature: form.signature,
      fields: [parsed.username, parsed.password, parsed.newPassword, parsed.confirmPassword]
        .filter((field) => field !== null)
        .map((field) => field.element)
    }
  }

  const reportRoot = (root: BrowserPasswordFormRoot, source: BrowserPasswordSubmitSource): void => {
    const form = context.scanner.scan().find((candidate) => candidate.root === root)
    if (form) {
      report(form, source)
    }
  }

  return {
    onSubmit(event) {
      const target = event.composedPath()[0]
      if (event.isTrusted && target instanceof HTMLFormElement) {
        reportRoot(formRootOf(target), 'submit')
      }
    },
    onKeyDown(event) {
      if (!event.isTrusted || event.key !== 'Enter' || event.isComposing) {
        return
      }
      const input = inputFromEvent(event)
      const form = input ? context.scanner.scanFormOf(input) : null
      if (input && form && fieldRoleOf(form, input)) {
        report(form, 'enter')
      }
    },
    onClick(event) {
      const control = event.isTrusted ? findSubmitControl(event) : null
      if (control) {
        reportRoot(formRootOf(control), 'button')
      }
    },
    checkFormGone() {
      if (!watched) {
        return
      }
      const rootGone = watched.root instanceof HTMLFormElement && !watched.root.isConnected
      const fieldsGone = watched.fields.every(
        // Why not `disabled`: many forms disable their fields while the login request runs.
        (field) => !field.isConnected || !isRenderedElement(field)
      )
      if (!rootGone && !fieldsGone) {
        return
      }
      const payload: BrowserPasswordGuestFormGone = { formSignature: watched.signature }
      watched = null
      context.port.send(PRELOAD_BROWSER_PASSWORDS_GUEST_CHANNELS.formGone, payload)
    }
  }
}
