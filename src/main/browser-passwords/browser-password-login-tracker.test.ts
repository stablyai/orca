import { describe, expect, it } from 'vitest'
import type { BrowserPasswordGuestCapture } from '../../shared/browser-passwords-types'
import {
  BrowserPasswordLoginTracker,
  type BrowserPasswordSucceededLogin
} from './browser-password-login-tracker'

const ORIGIN = 'https://accounts.example.com'

function capture(
  overrides: Partial<BrowserPasswordGuestCapture> = {}
): BrowserPasswordGuestCapture {
  return {
    formSignature: 'form-1',
    kind: 'login',
    usernameFieldName: 'email',
    passwordFieldName: 'password',
    action: 'https://accounts.example.com/session',
    username: 'ada@example.com',
    password: 'correct horse',
    newPassword: null,
    ...overrides
  }
}

function setup(): {
  tracker: BrowserPasswordLoginTracker
  succeeded: BrowserPasswordSucceededLogin[]
  runTimers: () => void
  advance: (ms: number) => void
} {
  const succeeded: BrowserPasswordSucceededLogin[] = []
  let now = 0
  const timers = new Set<{ at: number; run: () => void }>()
  const tracker = new BrowserPasswordLoginTracker({
    onLoginSucceeded: (login) => succeeded.push(login),
    schedule: (delayMs, run) => {
      const timer = { at: now + delayMs, run }
      timers.add(timer)
      return () => timers.delete(timer)
    },
    now: () => now
  })
  const advance = (ms: number): void => {
    now += ms
    for (const timer of timers) {
      if (timer.at <= now) {
        timers.delete(timer)
        timer.run()
      }
    }
  }
  return { tracker, succeeded, runTimers: () => advance(60_000), advance }
}

describe('BrowserPasswordLoginTracker', () => {
  it.each(['returned-form', 'http-error', 'timeout'])(
    'does not revive a rejected %s attempt on a later page navigation',
    (failure) => {
      const { tracker, succeeded, runTimers } = setup()
      tracker.typed(ORIGIN, capture())
      tracker.submitted(ORIGIN, capture())
      if (failure === 'timeout') {
        runTimers()
      } else {
        tracker.navigationStarted(true)
        tracker.navigated(failure === 'http-error' ? 401 : 200)
        tracker.documentReady()
        if (failure === 'returned-form') {
          tracker.pageForms([capture()])
        }
      }
      tracker.navigationStarted(true)
      tracker.navigated(200)
      tracker.documentReady()
      runTimers()
      expect(succeeded).toEqual([])
    }
  )

  it('forgets a provisional password when its field is erased', () => {
    const { tracker, succeeded, runTimers } = setup()
    tracker.typed(ORIGIN, capture())
    tracker.typed(ORIGIN, capture({ password: null }))
    tracker.navigationStarted(true)
    tracker.navigated(200)
    tracker.documentReady()
    runTimers()
    expect(succeeded).toEqual([])
  })

  it.each(['password', null])(
    'recognizes a returned form when inferred kind changes with field name %j',
    (passwordFieldName) => {
      const { tracker, succeeded, runTimers } = setup()
      tracker.submitted(ORIGIN, capture({ kind: 'signup', passwordFieldName }))
      tracker.navigationStarted(true)
      tracker.navigated(200)
      tracker.documentReady()
      tracker.pageForms([
        { ...capture({ passwordFieldName }), formSignature: 'new-document', kind: 'change' }
      ])
      runTimers()
      expect(succeeded).toEqual([])
    }
  )

  it('keeps a valid attempt through an intermediate script redirect', () => {
    const { tracker, succeeded, advance } = setup()
    tracker.submitted(ORIGIN, capture())
    tracker.navigationStarted(true)
    tracker.navigated(200)
    tracker.documentReady()
    advance(2000)
    tracker.navigationStarted(true)
    advance(1000)
    expect(succeeded).toEqual([])
    tracker.navigated(200)
    tracker.documentReady()
    advance(2500)
    expect(succeeded).toHaveLength(1)
  })

  it('offers a classic form POST once the next page settles without the form', () => {
    const { tracker, succeeded, runTimers } = setup()
    tracker.typed(ORIGIN, capture())
    tracker.submitted(ORIGIN, capture())
    tracker.navigationStarted(true)
    tracker.navigated(200)
    tracker.documentReady()
    tracker.pageForms([])
    runTimers()
    expect(succeeded).toEqual([{ origin: ORIGIN, capture: capture(), username: 'ada@example.com' }])
  })

  it('treats an HTTP error on the next page as a failed login', () => {
    const { tracker, succeeded, runTimers } = setup()
    tracker.submitted(ORIGIN, capture())
    tracker.navigationStarted(true)
    tracker.navigated(401)
    runTimers()
    expect(succeeded).toEqual([])
  })

  it('treats the same form showing up again as a failed login', () => {
    const { tracker, succeeded, runTimers } = setup()
    tracker.submitted(ORIGIN, capture())
    tracker.navigationStarted(true)
    tracker.navigated(200)
    tracker.documentReady()
    // A fresh document gives the form a new signature; its field names still match.
    tracker.pageForms([{ ...capture(), formSignature: 'form-2' }])
    runTimers()
    expect(succeeded).toEqual([])
  })

  it('waits for a slow next page to be ready before judging it', () => {
    const { tracker, succeeded, advance } = setup()
    tracker.submitted(ORIGIN, capture())
    tracker.navigationStarted(true)
    tracker.navigated(200)
    advance(10_000)
    tracker.documentReady()
    tracker.pageForms([{ ...capture(), formSignature: 'form-2' }])
    advance(10_000)
    expect(succeeded).toEqual([])
  })

  it('counts a single-page login when the submitted form goes away', () => {
    const { tracker, succeeded } = setup()
    tracker.submitted(ORIGIN, capture())
    tracker.formGone('form-1')
    expect(succeeded).toHaveLength(1)
  })

  it('drops a single-page attempt whose form is still there after the failure window', () => {
    const { tracker, succeeded, advance } = setup()
    tracker.submitted(ORIGIN, capture())
    advance(6000)
    tracker.formGone('form-1')
    expect(succeeded).toEqual([])
  })

  it('treats a page-started navigation after typing as a submit the page script performed', () => {
    const { tracker, succeeded, runTimers } = setup()
    tracker.typed(ORIGIN, capture())
    tracker.navigationStarted(true)
    tracker.navigated(200)
    tracker.documentReady()
    runTimers()
    expect(succeeded).toHaveLength(1)
  })

  it('forgets typed values when the user navigates away from the address bar', () => {
    const { tracker, succeeded, runTimers } = setup()
    tracker.typed(ORIGIN, capture())
    tracker.navigationStarted(false)
    tracker.navigated(200)
    tracker.documentReady()
    runTimers()
    expect(succeeded).toEqual([])
  })

  it('carries the username from a username-first step onto the password step', () => {
    const { tracker, succeeded } = setup()
    tracker.submitted(
      ORIGIN,
      capture({ formSignature: 'step-1', kind: 'username-only', password: null })
    )
    const passwordStep = capture({ formSignature: 'step-2', username: null })
    tracker.submitted(ORIGIN, passwordStep)
    tracker.formGone('step-2')
    expect(succeeded).toEqual([
      { origin: ORIGIN, capture: passwordStep, username: 'ada@example.com' }
    ])
  })

  it('does not lend a username across sites or after five minutes', () => {
    const { tracker, succeeded, advance } = setup()
    tracker.submitted(
      'https://other.test',
      capture({ formSignature: 'step-1', kind: 'username-only', password: null })
    )
    tracker.submitted(ORIGIN, capture({ formSignature: 'step-2', username: null }))
    tracker.formGone('step-2')
    tracker.submitted(
      ORIGIN,
      capture({ formSignature: 'step-3', kind: 'username-only', password: null })
    )
    advance(5 * 60 * 1000 + 1)
    tracker.submitted(ORIGIN, capture({ formSignature: 'step-4', username: null }))
    tracker.formGone('step-4')
    expect(succeeded.map((login) => login.username)).toEqual([null, null])
  })

  it('never offers a username on its own', () => {
    const { tracker, succeeded } = setup()
    tracker.submitted(ORIGIN, capture({ kind: 'username-only', password: null }))
    tracker.formGone('form-1')
    expect(succeeded).toEqual([])
  })
})
