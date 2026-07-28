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
        unsupportedRuntimes: ['wsl']
      },
      {
        id: 'claude-agent-teams',
        cmd: 'orca-dev',
        requiredCommands: ['claude'],
        unsupportedRuntimes: ['wsl']
      },
      {
        id: 'claude-agent-teams',
        cmd: 'orca-ide',
        requiredCommands: ['claude'],
        unsupportedRuntimes: ['wsl']
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
    // Why: Windows now runs the same native-pane shim, so detection must probe
    // there or Settings reports Agent Teams as "Available to install" forever.
    expect(getTuiAgentDetectionProbeCommands(commands, 'win32')).toEqual([
      'orca',
      'claude',
      'orca-dev',
      'orca-ide'
    ])
    expect(resolveDetectedTuiAgentIds(commands, new Set(['orca', 'claude']), 'win32')).toEqual([
      'claude-agent-teams'
    ])
    expect(resolveDetectedTuiAgentIds(commands, new Set(['orca']), 'win32')).toEqual([])
    // Why: WSL stays unsupported — the shim calls back into the host Orca
    // process, which a WSL-side CLI cannot reach.
    expect(getTuiAgentDetectionProbeCommands(commands, 'wsl')).toEqual([])
    expect(resolveDetectedTuiAgentIds(commands, new Set(['orca-ide', 'claude']), 'wsl')).toEqual([])
  })
})
