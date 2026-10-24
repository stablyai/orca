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
    recordManagedHookInstallFailure('codex', new Error(`install failed: ${'x'.repeat(500)}`))

    expect(trackMock).toHaveBeenCalledExactlyOnceWith('agent_hook_install_failed', {
      agent: 'codex',
      error_message: `install failed: ${'x'.repeat(184)}`
    })
  })

  it('handles non-Error values and telemetry failures', () => {
    trackMock.mockImplementationOnce(() => {
      throw new Error('telemetry failed')
    })

    expect(() => recordManagedHookInstallFailure('cursor', { code: 'EACCES' })).not.toThrow()
    expect(trackMock).toHaveBeenCalledExactlyOnceWith('agent_hook_install_failed', {
      agent: 'cursor',
      error_message: '{"code":"EACCES"}'
    })
    expect(console.error).toHaveBeenCalledWith(
      '[agent-hooks] Failed to record install-failure telemetry:',
      expect.objectContaining({ message: 'telemetry failed' })
    )
  })
})
