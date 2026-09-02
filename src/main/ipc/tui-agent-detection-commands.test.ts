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

  it('requires Claude before reporting openzoo on every runtime', () => {
    // Why: `openzoo claude` hosts the real Claude Code CLI, so a bare `openzoo` binary
    // (the payment proxy) must not surface a launchable agent that would fail on start.
    const commands = KNOWN_TUI_AGENT_DETECTION_COMMANDS.filter(
      (command) => command.id === 'openzoo'
    )

    expect(commands).toEqual([{ id: 'openzoo', cmd: 'openzoo', requiredCommands: ['claude'] }])
    for (const runtime of ['linux', 'darwin', 'win32', 'wsl'] as const) {
      expect(getTuiAgentDetectionProbeCommands(commands, runtime)).toEqual(['openzoo', 'claude'])
      expect(resolveDetectedTuiAgentIds(commands, new Set(['openzoo']), runtime)).toEqual([])
      expect(resolveDetectedTuiAgentIds(commands, new Set(['claude']), runtime)).toEqual([])
      expect(resolveDetectedTuiAgentIds(commands, new Set(['openzoo', 'claude']), runtime)).toEqual(
        ['openzoo']
      )
    }
  })
})
