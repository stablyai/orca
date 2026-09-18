import { describe, expect, it } from 'vitest'
import {
  buildManagedHookDetectionCommands,
  detectedManagedHookAgents
} from './managed-hook-detection-commands'
import { excludeMisidentifiedAgents } from '../../shared/tui-agent-identity-exclusion'

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

  // Why: SSH/WSL install allowlists run this list through the relay's identity probe.
  it('carries the identity exclusion so a remote Neovim bob is not detected', async () => {
    const commands = buildManagedHookDetectionCommands({ disabledTuiAgents: [] }, 'linux')
    const bob = commands.filter((command) => command.id === 'bob')
    expect(bob.length).toBeGreaterThan(0)
    expect(bob.every((command) => command.identityExclusion)).toBe(true)
    expect(commands.find((command) => command.id === 'codex')?.identityExclusion).toBeUndefined()

    const wire: typeof commands = JSON.parse(JSON.stringify(commands))
    await expect(
      excludeMisidentifiedAgents(wire, ['bob'], new Set(['bob']), async () => ({
        stdout: 'bob 4.0.0\nA version manager for neovim',
        stderr: ''
      }))
    ).resolves.toEqual([])
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
