import { describe, expect, it } from 'vitest'
import {
  buildManagedHookDetectionCommands,
  detectedManagedHookAgents
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
})
