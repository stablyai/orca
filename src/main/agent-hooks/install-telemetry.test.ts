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
    recordManagedHookInstallFailure('codex', new Error('x'.repeat(500)))

    expect(trackMock).toHaveBeenCalledTimes(1)
    const [eventName, props] = trackMock.mock.calls[0] as [
      string,
      { agent: string; error_message: string }
    ]
    expect(eventName).toBe('agent_hook_install_failed')
    expect(props.agent).toBe('codex')
    expect(props.error_message).toBe('unknown')
  })

  it('sends only the errno code for filesystem errors, never the path', () => {
    recordManagedHookInstallFailure(
      'claude',
      Object.assign(
        new Error("EACCES: permission denied, open '/home/someone/.claude/settings.json'"),
        { code: 'EACCES' }
      )
    )

    const [, props] = trackMock.mock.calls[0] as [string, { error_message: string }]
    expect(props.error_message).toBe('EACCES')
    expect(props.error_message).not.toContain('/')
  })

  it('sends SyntaxError for malformed config JSON without the parser message', () => {
    let parseError: unknown
    try {
      JSON.parse('{"hooks": /home/someone')
    } catch (error) {
      parseError = error
    }

    recordManagedHookInstallFailure('codex', parseError)

    const [, props] = trackMock.mock.calls[0] as [string, { error_message: string }]
    expect(props.error_message).toBe('SyntaxError')
  })

  it('sends unknown for errors without a recognizable category', () => {
    recordManagedHookInstallFailure('cursor', { path: '/home/someone/.cursor/hooks.json' })
    recordManagedHookInstallFailure('cursor', new Error('failed at /home/someone/.cursor'))
    recordManagedHookInstallFailure(
      'cursor',
      Object.assign(new Error('x'), { code: 'not-an-errno /home/someone' })
    )
    // An errno-looking prefix must not carry the rest of the code through.
    recordManagedHookInstallFailure(
      'cursor',
      Object.assign(new Error('x'), { code: 'EACCES /home/someone' })
    )

    const messages = trackMock.mock.calls.map(
      ([, props]) => (props as { error_message: string }).error_message
    )
    expect(messages).toEqual(['unknown', 'unknown', 'unknown', 'unknown'])
  })

  it('handles non-Error values and telemetry failures', () => {
    trackMock.mockImplementationOnce(() => {
      throw new Error('telemetry failed')
    })

    expect(() => recordManagedHookInstallFailure('cursor', { code: 'EACCES' })).not.toThrow()
  })
})
