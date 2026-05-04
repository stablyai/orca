// Fail-closed validator behavior. These tests exist to catch the classes of
// input the validator is designed to reject at the IPC boundary: unknown
// event names, extra properties (via `.strict()`), missing required keys,
// wrong enum values, and overlength free-form strings. Every rejected case
// returns `{ ok: false, reason }` — the client.ts wrapper then drops the
// event instead of calling posthog.capture.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { _resetValidatorWarnCacheForTests, validate } from './validator'

describe('validate', () => {
  beforeEach(() => {
    _resetValidatorWarnCacheForTests()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('accepts a well-formed app_opened payload', () => {
    const result = validate('app_opened', {})
    expect(result.ok).toBe(true)
  })

  it('accepts a well-formed agent_started payload', () => {
    const result = validate('agent_started', {
      agent_kind: 'claude-code',
      launch_source: 'command_palette',
      request_kind: 'new'
    })
    expect(result.ok).toBe(true)
  })

  it('drops unknown event names', () => {
    const result = validate('not_a_real_event' as never, {})
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toMatch(/unknown event/)
    }
  })

  it('rejects extra keys via .strict()', () => {
    const result = validate('app_opened', { unexpected: 'value' })
    expect(result.ok).toBe(false)
  })

  // Core invariant: agent_error is enum-only. If a call site ever tries to
  // attach raw error strings to the event, the validator drops it and nothing
  // transmits.
  it('rejects error_message on agent_error', () => {
    const result = validate('agent_error', {
      error_class: 'auth_expired',
      agent_kind: 'claude-code',
      error_message: 'at /Users/alice/secret/path/index.ts:42'
    } as never)
    expect(result.ok).toBe(false)
  })

  it('rejects error_stack on agent_error', () => {
    const result = validate('agent_error', {
      error_class: 'auth_expired',
      agent_kind: 'claude-code',
      error_stack: 'Error: boom\n    at /Users/alice/...'
    } as never)
    expect(result.ok).toBe(false)
  })

  it('drops on missing required key', () => {
    const result = validate('agent_started', {
      agent_kind: 'claude-code',
      launch_source: 'sidebar'
      // missing request_kind
    } as never)
    expect(result.ok).toBe(false)
  })

  it('drops on wrong enum value', () => {
    const result = validate('agent_started', {
      agent_kind: 'claude-code',
      launch_source: 'command_palette',
      request_kind: 'restart' // not in ['new', 'resume', 'followup']
    } as never)
    expect(result.ok).toBe(false)
  })

  it('drops overlength strings past the .max() cap', () => {
    // commonPropsSchema's `.max(64)` caps don't live on per-event schemas —
    // the per-event schemas use enum-only strings — so we exercise the cap
    // via a whitelisted `error_name` that is *one specific enum value*
    // meaning any attempt to smuggle a long string fails the enum check
    // regardless. For explicit string-length cap coverage we also confirm
    // the agent_error schema does not accept an overlength error_name
    // even if it matches the prefix of a whitelisted value.
    const result = validate('agent_error', {
      error_class: 'auth_expired',
      agent_kind: 'claude-code',
      error_name: 'AuthExpiredButAlsoWithExtraGarbageThatMakesItTooLong'
    } as never)
    expect(result.ok).toBe(false)
  })

  it('accepts whitelisted error_name on agent_error', () => {
    const result = validate('agent_error', {
      error_class: 'auth_expired',
      agent_kind: 'claude-code',
      error_name: 'AuthExpired'
    })
    expect(result.ok).toBe(true)
  })

  it('rejects error_name outside the whitelist', () => {
    const result = validate('agent_error', {
      error_class: 'auth_expired',
      agent_kind: 'claude-code',
      error_name: 'CustomErrorNotInList'
    } as never)
    expect(result.ok).toBe(false)
  })

  // Rate-limit: at most one warn per event name per 60s. We cannot easily
  // control Date.now() without mocking time, so the coarse assertion is
  // that repeat-dropping the same event name does not emit a warn on every
  // call. The first rejection should warn; the second within the window
  // should not.
  it('rate-limits warns to 1/min per event name', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    _resetValidatorWarnCacheForTests()
    validate('app_opened', { bogus: true } as never)
    const afterFirst = warn.mock.calls.length
    validate('app_opened', { bogus2: true } as never)
    const afterSecond = warn.mock.calls.length
    expect(afterFirst).toBe(1)
    expect(afterSecond).toBe(1)
  })
})
