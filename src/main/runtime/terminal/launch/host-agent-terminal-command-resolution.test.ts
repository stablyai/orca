import { describe, expect, it } from 'vitest'
import { resolveHostAgentTerminalCommand } from './host-agent-terminal-command-resolution'

const host: Parameters<typeof resolveHostAgentTerminalCommand>[1] = { shell: 'posix' }

describe('cursor command resolution', () => {
  it('falls back to cursor-agent when the host only has the legacy name', async () => {
    const launch = await resolveHostAgentTerminalCommand(
      { launchAgent: 'cursor', command: 'agent --yolo' },
      host,
      async () => new Set(['cursor-agent'])
    )
    expect(launch.command).toBe('cursor-agent --yolo')
  })

  it('keeps the legacy name on a host that cannot be probed', async () => {
    const launch = await resolveHostAgentTerminalCommand(
      { launchAgent: 'cursor', command: 'agent --yolo' },
      { connectionId: 'ssh-1', shell: 'posix' }
    )
    expect(launch.command).toBe('cursor-agent --yolo')
  })
})
