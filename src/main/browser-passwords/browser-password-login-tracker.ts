import type {
  BrowserPasswordFormSummary,
  BrowserPasswordGuestCapture
} from '../../shared/browser-passwords-types'
import { registrableDomainOf } from './browser-password-origin'

/** A login the tracker decided succeeded: offer to save it. */
export type BrowserPasswordSucceededLogin = {
  origin: string
  capture: BrowserPasswordGuestCapture
  /** The form's own username, else one typed on an earlier step of the same site. */
  username: string | null
}

type Attempt = {
  origin: string
  capture: BrowserPasswordGuestCapture
  // submitted: still on the same document, and only the form going away counts as success (an
  // in-page route change alone doesn't, as in Chromium); navigating: a cross-document load
  // started; loaded: the next document is ready and we wait to see if the form comes back.
  stage: 'submitted' | 'navigating' | 'loaded'
  cancelTimer: (() => void) | null
}

type UsernameCandidate = { site: string; username: string; at: number }

export type BrowserPasswordLoginTrackerOptions = {
  onLoginSucceeded: (login: BrowserPasswordSucceededLogin) => void
  schedule: (delayMs: number, run: () => void) => () => void
  now: () => number
}

// Proton's rule: a form still on screen this long after submit means the login failed.
const SAME_DOCUMENT_FAILURE_MS = 6000
// Time the next document gets to show the same form again (Chrome's "form reappeared" failure).
const NEXT_DOCUMENT_SETTLE_MS = 2500
// Chrome keeps a username typed on step one of a sign-in for five minutes.
const USERNAME_CANDIDATE_TTL_MS = 5 * 60 * 1000
const MAX_USERNAME_CANDIDATES = 10

function hasSecret(capture: BrowserPasswordGuestCapture): boolean {
  return Boolean(capture.password || capture.newPassword)
}

function isSameForm(
  form: BrowserPasswordFormSummary,
  capture: BrowserPasswordGuestCapture
): boolean {
  if (form.formSignature === capture.formSignature) {
    return true
  }
  if (form.action && form.action === capture.action) {
    return true
  }
  return (
    form.passwordFieldName !== null &&
    form.passwordFieldName === capture.passwordFieldName &&
    form.usernameFieldName === capture.usernameFieldName
  )
}

/**
 * Decides, per browser tab, whether a typed login worked, using Chromium's signals rebuilt from
 * DOM and navigation events: provisional save on typing, failure on an HTTP error or the same form
 * showing up again, success when the next page settles without it or the submitted form goes away.
 */
export class BrowserPasswordLoginTracker {
  private pendingCapture: { origin: string; capture: BrowserPasswordGuestCapture } | null = null
  private attempt: Attempt | null = null
  private usernameCandidates: UsernameCandidate[] = []

  constructor(private readonly options: BrowserPasswordLoginTrackerOptions) {}

  typed(origin: string, capture: BrowserPasswordGuestCapture): void {
    if (hasSecret(capture)) {
      this.pendingCapture = { origin, capture }
    } else if (
      this.pendingCapture?.origin === origin &&
      this.pendingCapture.capture.formSignature === capture.formSignature
    ) {
      this.pendingCapture = null
    }
  }

  submitted(origin: string, capture: BrowserPasswordGuestCapture): void {
    if (!hasSecret(capture)) {
      if (capture.username) {
        this.rememberUsername(origin, capture.username)
      }
      return
    }
    this.startAttempt(origin, capture, 'submitted')
    this.schedule(SAME_DOCUMENT_FAILURE_MS, () => {
      if (this.attempt?.stage === 'submitted') {
        this.dropAttempt()
      }
    })
  }

  navigationStarted(rendererInitiated: boolean): void {
    if (this.attempt && (this.attempt.stage === 'submitted' || rendererInitiated)) {
      this.attempt.stage = 'navigating'
      this.cancelTimer()
      return
    }
    // A form POST or script navigation the detector saw no submit signal for still counts.
    if (this.pendingCapture && rendererInitiated) {
      this.startAttempt(this.pendingCapture.origin, this.pendingCapture.capture, 'navigating')
      return
    }
    this.pendingCapture = null
    this.dropAttempt()
  }

  navigated(httpStatus: number): void {
    if (this.attempt?.stage !== 'navigating') {
      return
    }
    if (httpStatus >= 400) {
      this.dropAttempt()
    }
  }

  /** The next document is parsed; from here it has a moment to show the same form again. */
  documentReady(): void {
    if (this.attempt?.stage === 'navigating') {
      this.awaitSettle()
    }
  }

  pageForms(forms: BrowserPasswordFormSummary[]): void {
    const attempt = this.attempt
    if (attempt?.stage === 'loaded' && forms.some((form) => isSameForm(form, attempt.capture))) {
      this.dropAttempt()
    }
  }

  formGone(formSignature: string): void {
    const attempt = this.attempt
    if (
      attempt &&
      attempt.stage !== 'navigating' &&
      attempt.capture.formSignature === formSignature
    ) {
      this.succeed()
    }
  }

  dispose(): void {
    this.dropAttempt()
    this.pendingCapture = null
    this.usernameCandidates = []
  }

  private startAttempt(
    origin: string,
    capture: BrowserPasswordGuestCapture,
    stage: Attempt['stage']
  ): void {
    this.cancelTimer()
    this.pendingCapture = null
    this.attempt = { origin, capture, stage, cancelTimer: null }
  }

  private awaitSettle(): void {
    if (!this.attempt) {
      return
    }
    this.attempt.stage = 'loaded'
    this.schedule(NEXT_DOCUMENT_SETTLE_MS, () => {
      if (this.attempt?.stage === 'loaded') {
        this.succeed()
      }
    })
  }

  private succeed(): void {
    const attempt = this.attempt
    if (!attempt) {
      return
    }
    this.cancelTimer()
    this.attempt = null
    this.pendingCapture = null
    const username = attempt.capture.username || this.takeUsername(attempt.origin)
    this.options.onLoginSucceeded({ origin: attempt.origin, capture: attempt.capture, username })
  }

  navigationFailed(): void {
    this.dropAttempt()
  }

  private dropAttempt(): void {
    this.cancelTimer()
    this.pendingCapture = null
    this.attempt = null
  }

  private schedule(delayMs: number, run: () => void): void {
    if (!this.attempt) {
      return
    }
    this.cancelTimer()
    this.attempt.cancelTimer = this.options.schedule(delayMs, run)
  }

  private cancelTimer(): void {
    this.attempt?.cancelTimer?.()
    if (this.attempt) {
      this.attempt.cancelTimer = null
    }
  }

  private rememberUsername(origin: string, username: string): void {
    const site = registrableDomainOf(origin)
    if (!site) {
      return
    }
    this.usernameCandidates = [
      { site, username, at: this.options.now() },
      ...this.usernameCandidates.filter((candidate) => candidate.site !== site)
    ].slice(0, MAX_USERNAME_CANDIDATES)
  }

  private takeUsername(origin: string): string | null {
    const site = registrableDomainOf(origin)
    const cutoff = this.options.now() - USERNAME_CANDIDATE_TTL_MS
    const candidate = this.usernameCandidates.find(
      (entry) => entry.site === site && entry.at >= cutoff
    )
    if (!candidate) {
      return null
    }
    this.usernameCandidates = this.usernameCandidates.filter((entry) => entry !== candidate)
    return candidate.username
  }
}
