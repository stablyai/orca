import { describe, expect, it } from 'vitest'
import {
  getTuiAgentDetectionProbeCommands,
  KNOWN_TUI_AGENT_DETECTION_COMMANDS,
  resolveDetectedTuiAgentExecutables,
  resolveDetectedTuiAgentIds
} from './tui-agent-detection-commands'

describe('tui agent detected executables', () => {
  const cursorCommands = KNOWN_TUI_AGENT_DETECTION_COMMANDS.filter(
    (command) => command.id === 'cursor'
  )

  it('reports the alias when only the Cursor IDE binary is installed', () => {
    expect(
      resolveDetectedTuiAgentExecutables(cursorCommands, new Set(['cursor']), 'darwin')
    ).toEqual({ cursor: 'cursor' })
  })

  it('prefers the standalone binary when both are installed', () => {
    expect(
      resolveDetectedTuiAgentExecutables(
        cursorCommands,
        new Set(['cursor', 'cursor-agent']),
        'darwin'
      )
    ).toEqual({ cursor: 'cursor-agent' })
  })

  it('omits agents whose required commands are missing', () => {
    const teamsCommands = KNOWN_TUI_AGENT_DETECTION_COMMANDS.filter(
      (command) => command.id === 'claude-agent-teams'
    )

    expect(resolveDetectedTuiAgentExecutables(teamsCommands, new Set(['orca']), 'linux')).toEqual(
      {}
    )
    expect(
      resolveDetectedTuiAgentExecutables(teamsCommands, new Set(['orca', 'claude']), 'linux')
    ).toEqual({ 'claude-agent-teams': 'orca' })
  })
})

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
})
