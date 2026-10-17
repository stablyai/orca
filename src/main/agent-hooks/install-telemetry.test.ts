import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { trackMock } = vi.hoisted(() => ({ trackMock: vi.fn() }))

vi.mock('../telemetry/client', () => ({ track: trackMock }))

import { recordManagedHookInstallFailure } from './install-telemetry'

describe('recordManagedHookInstallFailure', () => {
  beforeEach(() => {
    trackMock.mockReset()
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('records the agent and an error code, never the raw message (#26604)', () => {
    const error = Object.assign(
      new Error("EACCES: permission denied, open '/home/alice/.claude/settings.json'"),
      { code: 'EACCES' }
    )
    recordManagedHookInstallFailure('codex', error)

    expect(trackMock).toHaveBeenCalledTimes(1)
    const [eventName, props] = trackMock.mock.calls[0] as [
      string,
      { agent: string; error_code: string }
    ]
    expect(eventName).toBe('agent_hook_install_failed')
    expect(props.agent).toBe('codex')
    expect(props.error_code).toBe('EACCES')
    expect(JSON.stringify(props)).not.toContain('permission denied')
    expect(JSON.stringify(props)).not.toContain('/home/alice')
  })

  it('falls back to the error class name when no code is present', () => {
    recordManagedHookInstallFailure('claude', new TypeError('Cannot read raw file contents'))

    const [, props] = trackMock.mock.calls[0] as [string, { error_code: string }]
    expect(props.error_code).toBe('TypeError')
    expect(JSON.stringify(props)).not.toContain('Cannot read')
  })

  it('rejects free-form code strings that could carry paths (#26604)', () => {
    const error = Object.assign(new Error('hidden message'), {
      code: 'EACCES: /home/alice/.claude/settings.json'
    })
    recordManagedHookInstallFailure('codex', error)

    const [, props] = trackMock.mock.calls[0] as [string, { error_code: string }]
    expect(props.error_code).toBe('Error')
    expect(JSON.stringify(props)).not.toContain('/home/alice')
    expect(JSON.stringify(props)).not.toContain('hidden message')
  })

  it('still records an event for objects with no constructor and no code', () => {
    recordManagedHookInstallFailure('cursor', Object.create(null))

    expect(trackMock).toHaveBeenCalledTimes(1)
    const [, props] = trackMock.mock.calls[0] as [string, { error_code: string }]
    expect(props.error_code).toBe('unknown')
  })

  it('handles non-Error values and telemetry failures', () => {
    trackMock.mockImplementationOnce(() => {
      throw new Error('telemetry failed')
    })

    expect(() => recordManagedHookInstallFailure('cursor', { code: 'EACCES' })).not.toThrow()
  })
})
