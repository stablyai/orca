import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BROWSER_CLIENT_HOST_AUTHORITY_MISMATCH_CODE } from '../../shared/browser-client-host-protocol'
import { isBrowserClientHostAuthorityReplaced } from './browser-client-host-authority-replacement'
import {
  BrowserClientHostAuthorityReplacementWait,
  DEFAULT_AUTHORITY_REPLACEMENT_GRACE_MS
} from './browser-client-host-authority-replacement-wait'

function errorWithCode(message: string, code: unknown): Error {
  return Object.assign(new Error(message), { code })
}

describe('browser client host authority replacement', () => {
  it('recognizes the structured mismatch code a current runtime sends', () => {
    const rejected = errorWithCode(
      'lease attach named a retired runtime',
      BROWSER_CLIENT_HOST_AUTHORITY_MISMATCH_CODE
    )

    expect(isBrowserClientHostAuthorityReplaced(rejected)).toBe(true)
  })

  it('recognizes the mismatch when a new client talks to a runtime older than the typed code', () => {
    // The pre-typed-code wire shape: same condition, reported as a generic error carrying the code
    // as its whole message. A false negative here destroys live guests on every restart.
    const rejected = new Error(BROWSER_CLIENT_HOST_AUTHORITY_MISMATCH_CODE)

    expect('code' in rejected).toBe(false)
    expect(isBrowserClientHostAuthorityReplaced(rejected)).toBe(true)
  })

  it('rejects a host error that carries an unrelated code and an unrelated message', () => {
    const unrelated = errorWithCode('browser host process exited', 'runtime_error')

    expect(isBrowserClientHostAuthorityReplaced(unrelated)).toBe(false)
  })

  it('rejects a codeless host error with an unrelated message', () => {
    expect(isBrowserClientHostAuthorityReplaced(new Error('browser host process exited'))).toBe(
      false
    )
  })

  it('rejects non-Error rejections, including a bare object carrying the mismatch code', () => {
    expect(isBrowserClientHostAuthorityReplaced(undefined)).toBe(false)
    expect(isBrowserClientHostAuthorityReplaced(null)).toBe(false)
    expect(isBrowserClientHostAuthorityReplaced(BROWSER_CLIENT_HOST_AUTHORITY_MISMATCH_CODE)).toBe(
      false
    )
    expect(
      isBrowserClientHostAuthorityReplaced({ code: BROWSER_CLIENT_HOST_AUTHORITY_MISMATCH_CODE })
    ).toBe(false)
  })

  it('rejects a non-string code that a loose comparison could coerce', () => {
    expect(isBrowserClientHostAuthorityReplaced(errorWithCode('host rejected attach', 503))).toBe(
      false
    )
    expect(
      isBrowserClientHostAuthorityReplaced(
        errorWithCode('host rejected attach', {
          toString: () => BROWSER_CLIENT_HOST_AUTHORITY_MISMATCH_CODE
        })
      )
    ).toBe(false)
  })

  it('rejects a message that merely contains the mismatch code inside a longer sentence', () => {
    // Substring matching was rejected deliberately: it would keep guests alive on unrelated errors
    // that happen to quote the code.
    const quoted = new Error(`failed: ${BROWSER_CLIENT_HOST_AUTHORITY_MISMATCH_CODE} occurred`)

    expect(isBrowserClientHostAuthorityReplaced(quoted)).toBe(false)
  })

  it('pins the mismatch code string', () => {
    // Wire contract shared with the runtime: changing the value breaks mixed-version clients, whose
    // legacy message fallback compares against exactly this string.
    expect(BROWSER_CLIENT_HOST_AUTHORITY_MISMATCH_CODE).toBe(
      'browser_client_host_authority_mismatch'
    )
  })
})

describe('BrowserClientHostAuthorityReplacementWait', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('expires exactly once, at the grace deadline', () => {
    const wait = new BrowserClientHostAuthorityReplacementWait(1_000)
    const expire = vi.fn()

    wait.arm(expire)

    expect(wait.armed).toBe(true)
    vi.advanceTimersByTime(999)
    expect(expire).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(expire).toHaveBeenCalledOnce()
    expect(wait.armed).toBe(false)
    vi.advanceTimersByTime(10_000)
    expect(expire).toHaveBeenCalledOnce()
  })

  // A replaced runtime typically produces a burst of mismatch errors, one per in-flight attach.
  // Re-arming per error would push the deadline out indefinitely, which is the unbounded hold the
  // class exists to prevent.
  it('keeps the first deadline when armed again while already armed', () => {
    const wait = new BrowserClientHostAuthorityReplacementWait(1_000)
    const first = vi.fn()
    const second = vi.fn()

    wait.arm(first)
    vi.advanceTimersByTime(900)
    wait.arm(second)
    vi.advanceTimersByTime(100)

    expect(first).toHaveBeenCalledOnce()
    expect(second).not.toHaveBeenCalled()
  })

  it('never expires after a cancel', () => {
    const wait = new BrowserClientHostAuthorityReplacementWait(1_000)
    const expire = vi.fn()
    wait.arm(expire)

    wait.cancel()

    expect(wait.armed).toBe(false)
    vi.advanceTimersByTime(10_000)
    expect(expire).not.toHaveBeenCalled()
  })

  it('is re-armable after a cancel and after an expiry', () => {
    const wait = new BrowserClientHostAuthorityReplacementWait(1_000)
    const cancelled = vi.fn()
    const rearmed = vi.fn()
    wait.arm(cancelled)
    wait.cancel()

    wait.arm(rearmed)
    vi.advanceTimersByTime(1_000)

    expect(cancelled).not.toHaveBeenCalled()
    expect(rearmed).toHaveBeenCalledOnce()

    const afterExpiry = vi.fn()
    wait.arm(afterExpiry)
    vi.advanceTimersByTime(1_000)
    expect(afterExpiry).toHaveBeenCalledOnce()
  })

  it('tolerates cancelling when nothing is armed', () => {
    const wait = new BrowserClientHostAuthorityReplacementWait(1_000)

    expect(() => {
      wait.cancel()
      wait.cancel()
    }).not.toThrow()
    expect(wait.armed).toBe(false)
  })

  // The grace has to outlast a real restart, or the environment is torn down before the replacement
  // runtime finishes coming up.
  it('defaults the grace to 45 seconds', () => {
    expect(DEFAULT_AUTHORITY_REPLACEMENT_GRACE_MS).toBe(45_000)
  })
})
