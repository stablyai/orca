import { describe, expect, it } from 'vitest'
import { resolveInstalledAgentTerminalCommand } from './installed-agent-command-resolution'
import { KNOWN_TUI_AGENT_DETECTION_COMMANDS } from '../../../../shared/agent-launch/catalog/tui-agent-detection-commands'

const posix = { shell: 'posix' } as const

function launch(command: string) {
  return {
    launchAgent: 'aiwork' as const,
    command,
    launchConfig: { agentCommand: 'aiwork tui', agentArgs: '-y', agentEnv: {} }
  }
}

describe('AiWork release command names', () => {
  it('detects the China and global launchers, each only alongside aiwork-tui', () => {
    expect(
      KNOWN_TUI_AGENT_DETECTION_COMMANDS.filter((command) => command.id === 'aiwork').map(
        (command) => [command.cmd, command.requiredCommands]
      )
    ).toEqual([
      ['aiwork', ['aiwork-tui']],
      ['aiworkcn', ['aiwork-tui']],
      ['aiworkcli', ['aiwork-tui']]
    ])
  })

  it.each(['aiworkcn', 'aiworkcli'])(
    'launches %s when it is the installed launcher',
    async (name) => {
      const resolved = await resolveInstalledAgentTerminalCommand(
        launch('aiwork tui -y'),
        posix,
        async () => new Set([name, 'aiwork-tui'])
      )
      expect(resolved.command).toBe(`${name} tui -y`)
      expect(resolved.launchConfig.agentCommand).toBe(`${name} tui`)
    }
  )

  it('prefers a release launcher over an `aiwork` that may belong to another tool', async () => {
    const resolved = await resolveInstalledAgentTerminalCommand(
      launch('aiwork tui -y'),
      posix,
      async () => new Set(['aiwork', 'aiworkcn', 'aiwork-tui'])
    )
    expect(resolved.command).toBe('aiworkcn tui -y')
  })

  it("keeps Qoder's own preference for qodercli", async () => {
    const resolved = await resolveInstalledAgentTerminalCommand(
      { launchAgent: 'qoder' as const, command: 'qodercli' },
      posix,
      async () => new Set(['qodercli', 'qoder'])
    )
    expect(resolved.command).toBe('qodercli')
  })
})
