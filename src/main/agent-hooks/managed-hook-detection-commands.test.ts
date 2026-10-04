import { describe, expect, it } from 'vitest'
import { AGENT_HOOK_REASONIX_RUNTIME_CAPABILITY } from '../../shared/protocol-version'
import {
  buildManagedHookDetectionCommands,
  detectedManagedHookAgents,
  readManagedHookDetectionResult
} from './managed-hook-detection-commands'

describe('managed hook detection commands', () => {
  it('omits disabled agents and includes safe command overrides', () => {
    const commands = buildManagedHookDetectionCommands(
      {
        disabledTuiAgents: ['claude'],
        agentCmdOverrides: { codex: '/opt/codex custom' }
      },
      'linux'
    )

    expect(commands.some((command) => command.id === 'claude')).toBe(false)
    expect(commands).toContainEqual({ id: 'codex', cmd: '/opt/codex' })
  })

  it('maps detected TUI ids back to managed hook targets', () => {
    expect(detectedManagedHookAgents(['codex', 'opencode', 'droid'])).toEqual(['codex', 'droid'])
  })

  it('requests a version only for Claude capability detection', () => {
    const commands = buildManagedHookDetectionCommands(null, 'linux')

    expect(commands.find((command) => command.id === 'claude')).toMatchObject({
      reportVersion: true
    })
    expect(commands.find((command) => command.id === 'codex')?.reportVersion).toBeUndefined()
  })

  it('keeps Reasonix out of old relay closed hook enums without excluding other agents', () => {
    expect(readManagedHookDetectionResult({ agents: ['claude', 'codex', 'reasonix'] })).toEqual({
      agents: ['claude', 'codex'],
      claudeVersion: null
    })
  })

  it('uses the advertised configuration root from the execution host', () => {
    expect(
      readManagedHookDetectionResult({
        agents: ['codex', 'reasonix'],
        capabilities: [AGENT_HOOK_REASONIX_RUNTIME_CAPABILITY],
        reasonixConfigHome: '/srv/private/reasonix'
      })
    ).toEqual({
      agents: ['codex', 'reasonix'],
      claudeVersion: null,
      reasonixConfigHome: '/srv/private/reasonix'
    })
  })

  it.each([undefined, 'relative', '/srv/\nroot', '/srv/\\root', `/${'r'.repeat(4096)}`])(
    'refuses an advertised unsafe Reasonix root %j',
    (reasonixConfigHome) => {
      expect(
        readManagedHookDetectionResult({
          agents: ['codex', 'reasonix'],
          capabilities: [AGENT_HOOK_REASONIX_RUNTIME_CAPABILITY],
          reasonixConfigHome
        })
      ).toEqual({ agents: ['codex'], claudeVersion: null })
    }
  )

  it('refuses a root supplied by a host that never advertised Reasonix support', () => {
    expect(
      readManagedHookDetectionResult({
        agents: ['reasonix'],
        capabilities: ['some-future-capability'],
        reasonixConfigHome: '/srv/reasonix'
      })
    ).toEqual({ agents: [], claudeVersion: null })
  })
})
