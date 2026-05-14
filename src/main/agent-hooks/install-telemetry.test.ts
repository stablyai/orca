// Pins the contract between `runManagedHookInstallers` and the
// `agent_hook_install_failed` telemetry event: each catch must fire `track`
// with the correct agent label and a truncated error_message, and one
// installer's failure must not stop the others (fail-open semantics).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { trackMock } = vi.hoisted(() => ({ trackMock: vi.fn() }))

vi.mock('../telemetry/client', () => ({ track: trackMock }))

import { runManagedHookInstallers } from './install-telemetry'

describe('runManagedHookInstallers', () => {
  beforeEach(() => {
    trackMock.mockReset()
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('runs every installer when none throw and never calls track', () => {
    const claude = vi.fn()
    const codex = vi.fn()
    runManagedHookInstallers([
      ['claude', claude],
      ['codex', codex]
    ])
    expect(claude).toHaveBeenCalledTimes(1)
    expect(codex).toHaveBeenCalledTimes(1)
    expect(trackMock).not.toHaveBeenCalled()
  })

  it('fires agent_hook_install_failed with the correct agent label when an installer throws', () => {
    runManagedHookInstallers([
      [
        'codex',
        () => {
          throw new Error('codex config malformed')
        }
      ]
    ])

    expect(trackMock).toHaveBeenCalledTimes(1)
    expect(trackMock).toHaveBeenCalledWith('agent_hook_install_failed', {
      agent: 'codex',
      error_message: 'codex config malformed'
    })
  })

  it('continues running later installers after an earlier one throws (fail-open)', () => {
    const codex = vi.fn()
    const gemini = vi.fn()
    runManagedHookInstallers([
      [
        'claude',
        () => {
          throw new Error('claude failed')
        }
      ],
      ['codex', codex],
      ['gemini', gemini]
    ])
    expect(codex).toHaveBeenCalledTimes(1)
    expect(gemini).toHaveBeenCalledTimes(1)
    expect(trackMock).toHaveBeenCalledTimes(1)
    expect(trackMock).toHaveBeenCalledWith(
      'agent_hook_install_failed',
      expect.objectContaining({ agent: 'claude' })
    )
  })

  it('truncates error_message to 200 chars', () => {
    const longMessage = 'x'.repeat(500)
    runManagedHookInstallers([
      [
        'gemini',
        () => {
          throw new Error(longMessage)
        }
      ]
    ])
    expect(trackMock).toHaveBeenCalledTimes(1)
    const [, props] = trackMock.mock.calls[0] as [string, { error_message: string }]
    expect(props.error_message.length).toBe(200)
  })

  it('handles non-Error throws', () => {
    runManagedHookInstallers([
      [
        'cursor',
        () => {
          throw 'cursor string failure'
        }
      ]
    ])
    expect(trackMock).toHaveBeenCalledWith('agent_hook_install_failed', {
      agent: 'cursor',
      error_message: 'cursor string failure'
    })
  })

  it('serializes thrown objects through JSON.stringify', () => {
    runManagedHookInstallers([
      [
        'cursor',
        () => {
          throw { code: 'EACCES', path: '/tmp' }
        }
      ]
    ])
    expect(trackMock).toHaveBeenCalledTimes(1)
    expect(trackMock).toHaveBeenCalledWith('agent_hook_install_failed', {
      agent: 'cursor',
      error_message: '{"code":"EACCES","path":"/tmp"}'
    })
  })

  it('does not throw when an installer throws undefined (regression for JSON.stringify undefined return)', () => {
    expect(() =>
      runManagedHookInstallers([
        [
          'cursor',
          () => {
            throw undefined
          }
        ]
      ])
    ).not.toThrow()
    expect(trackMock).toHaveBeenCalledTimes(1)
    const [eventName, props] = trackMock.mock.calls[0] as [string, { error_message: string }]
    expect(eventName).toBe('agent_hook_install_failed')
    expect(typeof props.error_message).toBe('string')
  })

  it('continues running later installers when track itself throws (telemetry must not break fail-open)', () => {
    const codex = vi.fn()
    trackMock.mockImplementationOnce(() => {
      throw new Error('telemetry blew up')
    })
    expect(() =>
      runManagedHookInstallers([
        [
          'claude',
          () => {
            throw new Error('claude failed')
          }
        ],
        ['codex', codex]
      ])
    ).not.toThrow()
    expect(codex).toHaveBeenCalledTimes(1)
  })
})
