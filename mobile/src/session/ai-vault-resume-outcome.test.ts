import { describe, expect, it } from 'vitest'
import {
  readMobileVaultResumeCreateOutcome,
  resolveMobileResumeOutcomeDisplay
} from './ai-vault-resume-outcome'

describe('readMobileVaultResumeCreateOutcome', () => {
  it('reads a plain-terminal bypass success as launched with no notices', () => {
    expect(
      readMobileVaultResumeCreateOutcome({ tab: { type: 'terminal', id: 't', terminal: 'p' } })
    ).toEqual({ kind: 'launched' })
  })

  it('reads host-persisted Vault fallback notices from the created tab', () => {
    expect(
      readMobileVaultResumeCreateOutcome({
        tab: {
          type: 'terminal',
          id: 't',
          launchNotices: {
            notices: [{ code: 'future_notice' }, { code: 'vault_original_config_unavailable' }]
          }
        }
      })
    ).toEqual({ kind: 'launched', notices: ['vault_original_config_unavailable'] })
  })

  it('maps a failed agentLaunch arm to its failure code', () => {
    expect(
      readMobileVaultResumeCreateOutcome({
        agentLaunch: { status: 'failed', failure: { code: 'invalid_launch_snapshot' } }
      })
    ).toEqual({ kind: 'failed', code: 'invalid_launch_snapshot' })
  })

  it('treats a rejected echoed identity as a generic, un-actionable failure', () => {
    expect(
      readMobileVaultResumeCreateOutcome({
        agentLaunch: { status: 'rejected', requestError: { code: 'untrusted_reference' } }
      })
    ).toEqual({ kind: 'failed', code: 'spawn_failed' })
  })

  it('fails closed on an unexpected envelope shape', () => {
    expect(readMobileVaultResumeCreateOutcome(null)).toEqual({
      kind: 'failed',
      code: 'spawn_failed'
    })
    expect(readMobileVaultResumeCreateOutcome({})).toEqual({ kind: 'failed', code: 'spawn_failed' })
  })
})

describe('mobile resume outcome display', () => {
  it('offers an explicit launch-with-current-settings action on an invalid snapshot', () => {
    const display = resolveMobileResumeOutcomeDisplay({
      kind: 'failed',
      code: 'invalid_launch_snapshot'
    })

    expect(display.tone).toBe('error')
    expect(display.action).toEqual({
      id: 'launch-current-settings',
      label: 'Launch with current settings'
    })
  })

  it('does not offer an action for other failure codes', () => {
    const display = resolveMobileResumeOutcomeDisplay({ kind: 'failed', code: 'spawn_failed' })

    expect(display.tone).toBe('error')
    expect(display.action).toBeUndefined()
  })

  it('confirms a clean launch when no notices are present', () => {
    const display = resolveMobileResumeOutcomeDisplay({ kind: 'launched' })

    expect(display).toEqual({ tone: 'success', message: 'Agent session queued.' })
  })

  it('reports withheld environment values as a non-blocking notice', () => {
    const display = resolveMobileResumeOutcomeDisplay({
      kind: 'launched',
      notices: ['env_withheld']
    })

    expect(display.tone).toBe('info')
    expect(display.action).toBeUndefined()
    expect(display.message).toContain('environment')
  })

  it('keeps snapshot-changed copy free of any env-value implication', () => {
    const display = resolveMobileResumeOutcomeDisplay({
      kind: 'launched',
      notices: ['snapshot_definition_changed']
    })

    expect(display.tone).toBe('info')
    expect(display.message.toLowerCase()).not.toContain('environment')
    expect(display.message.toLowerCase()).not.toContain('value')
  })

  it('combines both notices into one info message', () => {
    const display = resolveMobileResumeOutcomeDisplay({
      kind: 'launched',
      notices: ['snapshot_definition_changed', 'env_withheld']
    })

    expect(display.tone).toBe('info')
    expect(display.message).toContain('environment')
    expect(display.message).toContain('settings saved when this session started')
  })

  it('discloses the current-settings Vault fallback', () => {
    const display = resolveMobileResumeOutcomeDisplay({
      kind: 'launched',
      notices: ['vault_original_config_unavailable']
    })
    expect(display).toEqual({
      tone: 'info',
      message: 'Original launch settings were unavailable, so current settings were used.'
    })
  })
})
