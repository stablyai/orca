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
})
