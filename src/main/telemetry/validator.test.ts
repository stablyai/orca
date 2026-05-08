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
      error_class: 'unknown',
      agent_kind: 'claude-code',
      error_message: 'at /Users/alice/secret/path/index.ts:42'
    } as never)
    expect(result.ok).toBe(false)
  })

  it('rejects error_stack on agent_error', () => {
    const result = validate('agent_error', {
      error_class: 'unknown',
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

  it('accepts a well-formed agent_error payload', () => {
    const result = validate('agent_error', {
      error_class: 'binary_not_found',
      agent_kind: 'claude-code'
    })
    expect(result.ok).toBe(true)
  })

  it('rejects agent_error with a deferred enum value', () => {
    // `auth_expired` was in an earlier draft; the trimmed enum is
    // ['binary_not_found', 'unknown']. Pin that contract so re-introducing
    // a deferred value silently is impossible.
    const result = validate('agent_error', {
      error_class: 'auth_expired',
      agent_kind: 'claude-code'
    } as never)
    expect(result.ok).toBe(false)
  })

  // ── Cohort property (nth_repo_added) ────────────────────────────────
  // Pin the schema contract from
  // docs/onboarding-funnel-cohort-addendum.md. The field is optional so a
  // classifier degraded-mode `undefined` still validates; rejected shapes
  // (negative, non-integer, string) must drop.

  it('accepts app_opened with nth_repo_added=0 (the session-zero cohort signal)', () => {
    const result = validate('app_opened', { nth_repo_added: 0 })
    expect(result.ok).toBe(true)
  })

  it('accepts repo_added with nth_repo_added=1', () => {
    const result = validate('repo_added', { method: 'folder_picker', nth_repo_added: 1 })
    expect(result.ok).toBe(true)
  })

  it('accepts events without nth_repo_added (classifier degraded mode)', () => {
    const result = validate('agent_started', {
      agent_kind: 'claude-code',
      launch_source: 'command_palette',
      request_kind: 'new'
    })
    expect(result.ok).toBe(true)
  })

  it('rejects negative nth_repo_added', () => {
    const result = validate('app_opened', { nth_repo_added: -1 } as never)
    expect(result.ok).toBe(false)
  })

  it('rejects non-integer nth_repo_added', () => {
    const result = validate('app_opened', { nth_repo_added: 1.5 } as never)
    expect(result.ok).toBe(false)
  })

  it('rejects nth_repo_added on a non-cohort event (settings_changed)', () => {
    // The IPC handler relies on this rejection: schemas are `.strict()`,
    // so injecting `nth_repo_added` on an event whose schema does not
    // declare it must drop the entire event. The selectivity guard in
    // `telemetry:track` is what prevents that from happening in practice.
    const result = validate('settings_changed', {
      setting_key: 'editorAutoSave',
      value_kind: 'bool',
      nth_repo_added: 1
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
