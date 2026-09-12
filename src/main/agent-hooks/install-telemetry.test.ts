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

  it('records the agent and truncated error message', () => {
    recordManagedHookInstallFailure('codex', new Error('x'.repeat(500)))

    expect(trackMock).toHaveBeenCalledTimes(1)
    const [eventName, props] = trackMock.mock.calls[0] as [
      string,
      { agent: string; error_message: string }
    ]
    expect(eventName).toBe('agent_hook_install_failed')
    expect(props.agent).toBe('codex')
    expect(props.error_message).toHaveLength(200)
  })

  it('handles non-Error values and telemetry failures', () => {
    trackMock.mockImplementationOnce(() => {
      throw new Error('telemetry failed')
    })

    expect(() => recordManagedHookInstallFailure('cursor', { code: 'EACCES' })).not.toThrow()
  })
})
