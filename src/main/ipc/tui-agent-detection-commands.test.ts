import { describe, expect, it } from 'vitest'
import {
  getTuiAgentDetectionProbeCommands,
  KNOWN_TUI_AGENT_DETECTION_COMMANDS,
  resolveDetectedTuiAgentIds
} from './tui-agent-detection-commands'

describe('tui agent detection commands', () => {
  it('requires Claude before reporting Claude Agent Teams', () => {
    const commands = KNOWN_TUI_AGENT_DETECTION_COMMANDS.filter(
      (command) => command.id === 'claude-agent-teams'
    )

    expect(commands).toEqual([
      {
        id: 'claude-agent-teams',
        cmd: 'orca',
        requiredCommands: ['claude'],
        unsupportedRuntimes: ['win32', 'wsl']
      },
      {
        id: 'claude-agent-teams',
        cmd: 'orca-dev',
        requiredCommands: ['claude'],
        unsupportedRuntimes: ['win32', 'wsl']
      },
      {
        id: 'claude-agent-teams',
        cmd: 'orca-ide',
        requiredCommands: ['claude'],
        unsupportedRuntimes: ['win32', 'wsl']
      }
    ])
    expect(getTuiAgentDetectionProbeCommands(commands, 'linux')).toEqual([
      'orca',
      'claude',
      'orca-dev',
      'orca-ide'
    ])
    expect(resolveDetectedTuiAgentIds(commands, new Set(['orca']), 'linux')).toEqual([])
    expect(resolveDetectedTuiAgentIds(commands, new Set(['orca', 'claude']), 'linux')).toEqual([
      'claude-agent-teams'
    ])
    expect(getTuiAgentDetectionProbeCommands(commands, 'win32')).toEqual([])
    expect(resolveDetectedTuiAgentIds(commands, new Set(['orca', 'claude']), 'win32')).toEqual([])
    expect(getTuiAgentDetectionProbeCommands(commands, 'wsl')).toEqual([])
    expect(resolveDetectedTuiAgentIds(commands, new Set(['orca-ide', 'claude']), 'wsl')).toEqual([])
  })

  it('detects cursor agent via cursor-agent or cursor alias', () => {
    const commands = KNOWN_TUI_AGENT_DETECTION_COMMANDS.filter((command) => command.id === 'cursor')

    // Should have two detection entries: cursor-agent (primary) and cursor (alias)
    expect(commands).toEqual([
      { id: 'cursor', cmd: 'cursor-agent' },
      { id: 'cursor', cmd: 'cursor' }
    ])

    // Both commands should be probed
    expect(getTuiAgentDetectionProbeCommands(commands, 'linux')).toEqual(['cursor-agent', 'cursor'])

    // Detection via standalone cursor-agent binary
    expect(resolveDetectedTuiAgentIds(commands, new Set(['cursor-agent']), 'linux')).toEqual([
      'cursor'
    ])

    // Detection via standard Cursor IDE installation (cursor in PATH)
    expect(resolveDetectedTuiAgentIds(commands, new Set(['cursor']), 'linux')).toEqual(['cursor'])

    // Detection when both are present
    expect(
      resolveDetectedTuiAgentIds(commands, new Set(['cursor-agent', 'cursor']), 'linux')
    ).toEqual(['cursor'])

    // No detection when neither is present
    expect(resolveDetectedTuiAgentIds(commands, new Set(['claude']), 'linux')).toEqual([])
  })
})
