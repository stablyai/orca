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

  it('records the agent and an error category instead of the raw message', () => {
    recordManagedHookInstallFailure('codex', new Error('install failed'))

    expect(trackMock).toHaveBeenCalledExactlyOnceWith('agent_hook_install_failed', {
      agent: 'codex',
      error_message: 'unknown'
    })
  })

  it('sends only the errno code for filesystem errors, never the path', () => {
    recordManagedHookInstallFailure(
      'claude',
      Object.assign(
        new Error("EACCES: permission denied, open '/home/someone/.claude/settings.json'"),
        { code: 'EACCES' }
      )
    )

    expect(trackMock).toHaveBeenCalledExactlyOnceWith('agent_hook_install_failed', {
      agent: 'claude',
      error_message: 'EACCES'
    })
  })

  it('handles non-Error values and telemetry failures', () => {
    trackMock.mockImplementationOnce(() => {
      throw new Error('telemetry failed')
    })

    expect(() => recordManagedHookInstallFailure('cursor', { code: 'EACCES' })).not.toThrow()
    expect(trackMock).toHaveBeenCalledExactlyOnceWith('agent_hook_install_failed', {
      agent: 'cursor',
      error_message: 'EACCES'
    })
    expect(console.error).toHaveBeenCalledWith(
      '[agent-hooks] Failed to record install-failure telemetry:',
      expect.objectContaining({ message: 'telemetry failed' })
    )
  })
})
