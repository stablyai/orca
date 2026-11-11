import { describe, expect, it } from 'vitest'
import { resolveQoderTerminalCommand } from './qoder-terminal-command-resolution'

const host: Parameters<typeof resolveQoderTerminalCommand>[1] = { shell: 'posix' }

describe('cursor command resolution', () => {
  it('falls back to cursor-agent when the host only has the legacy name', async () => {
    const launch = await resolveQoderTerminalCommand(
      { launchAgent: 'cursor', command: 'agent --yolo' },
      host,
      async () => new Set(['cursor-agent'])
    )
    expect(launch.command).toBe('cursor-agent --yolo')
  })
})
