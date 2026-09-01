import { describe, expect, it } from 'vitest'
import {
  isCapturedAgentTeamsConfig,
  pathDelimiterForShell,
  stripLegacyReplayEnv
} from './agent-launch-legacy-teams-env'

// A captured Claude Agent Teams leader env (see createLaunchEnv), plus a user's
// own custom key that must survive replay.
function capturedTeamEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
    PATH: '/home/me/.orca/claude-agent-teams-bin:/usr/local/bin:/usr/bin',
    TMUX: '/tmp/orca-claude-agent-teams/team-abc,0,1',
    TMUX_PANE: '%1',
    TERM: 'screen-256color',
    COLORTERM: 'truecolor',
    ORCA_AGENT_TEAMS_TEAM_ID: 'team-abc',
    ORCA_AGENT_TEAMS_TOKEN: 'secret-token',
    ORCA_AGENT_TEAMS_LEADER_PANE: '%1',
    ORCA_AGENT_TEAMS_SHIM_DIR: '/home/me/.orca/claude-agent-teams-bin',
    ORCA_AGENT_TEAMS_SHIM_BIN: '/opt/orca/bin/orca',
    ORCA_PAIRING_CODE: 'pair-123',
    ORCA_ENVIRONMENT: 'prod',
    ORCA_PANE_KEY: 'pane-key',
    MY_CUSTOM_TOKEN: 'keep-me',
    ...overrides
  }
}

describe('pathDelimiterForShell', () => {
  it('uses : on posix and ; on Windows shells', () => {
    expect(pathDelimiterForShell('posix')).toBe(':')
    expect(pathDelimiterForShell('powershell')).toBe(';')
    expect(pathDelimiterForShell('cmd')).toBe(';')
  })
})

describe('isCapturedAgentTeamsConfig', () => {
  it('detects a team config by its generated markers', () => {
    expect(isCapturedAgentTeamsConfig({ ORCA_AGENT_TEAMS_TEAM_ID: 'x' })).toBe(true)
    expect(isCapturedAgentTeamsConfig({ CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1' })).toBe(true)
  })

  it('does not flag an ordinary user env', () => {
    expect(isCapturedAgentTeamsConfig({ PATH: '/usr/bin', TERM: 'xterm', FOO: 'bar' })).toBe(false)
  })
})

describe('stripLegacyReplayEnv — non-team config', () => {
  it('preserves user PATH and TERM, stripping only orca attribution + tmux', () => {
    const cleaned = stripLegacyReplayEnv(
      {
        PATH: '/usr/local/bin:/usr/bin',
        TERM: 'xterm-256color',
        TMUX: 'x',
        TMUX_PANE: '%9',
        ORCA_PANE_KEY: 'pane',
        MY_TOKEN: 'keep'
      },
      'posix'
    )
    expect(cleaned).toEqual({
      PATH: '/usr/local/bin:/usr/bin',
      TERM: 'xterm-256color',
      MY_TOKEN: 'keep'
    })
  })

  it('carries an own __proto__ key through as plain data for downstream rejection', () => {
    // JSON/IPC deserialization can produce an own '__proto__' env key; it must
    // reach validateCustomAgentEnv's prototype_key check instead of vanishing
    // into (or polluting) the accumulator prototype.
    const env = JSON.parse('{"__proto__": "poison", "MY_TOKEN": "keep"}') as Record<string, string>
    const cleaned = stripLegacyReplayEnv(env, 'posix')
    expect(Object.getPrototypeOf(cleaned)).toBeNull()
    expect(Object.hasOwn(cleaned, '__proto__')).toBe(true)
    expect(cleaned.MY_TOKEN).toBe('keep')
  })
})

describe('stripLegacyReplayEnv — captured team config', () => {
  it('drops every generated team/auth/TMUX/TERM/pairing key and keeps user env', () => {
    const cleaned = stripLegacyReplayEnv(capturedTeamEnv(), 'posix')
    expect(cleaned.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBeUndefined()
    expect(cleaned.TMUX).toBeUndefined()
    expect(cleaned.TMUX_PANE).toBeUndefined()
    expect(cleaned.TERM).toBeUndefined()
    expect(cleaned.COLORTERM).toBeUndefined()
    expect(cleaned.ORCA_AGENT_TEAMS_TOKEN).toBeUndefined()
    expect(cleaned.ORCA_AGENT_TEAMS_SHIM_DIR).toBeUndefined()
    expect(cleaned.ORCA_PAIRING_CODE).toBeUndefined()
    expect(cleaned.ORCA_ENVIRONMENT).toBeUndefined()
    expect(cleaned.ORCA_PANE_KEY).toBeUndefined()
    // The user's own custom key survives.
    expect(cleaned.MY_CUSTOM_TOKEN).toBe('keep-me')
  })

  it('removes the proven shim prefix from PATH, preserving the user tail', () => {
    const cleaned = stripLegacyReplayEnv(capturedTeamEnv(), 'posix')
    expect(cleaned.PATH).toBe('/usr/local/bin:/usr/bin')
  })

  it('quotes the Windows shim prefix with the ; delimiter', () => {
    const cleaned = stripLegacyReplayEnv(
      capturedTeamEnv({
        PATH: 'C:\\Users\\me\\.orca\\bin;C:\\Windows\\System32',
        ORCA_AGENT_TEAMS_SHIM_DIR: 'C:\\Users\\me\\.orca\\bin'
      }),
      'powershell'
    )
    expect(cleaned.PATH).toBe('C:\\Windows\\System32')
  })

  it('drops PATH when the shim dir cannot be proven (ambiguous)', () => {
    const withoutShimDir = capturedTeamEnv()
    delete withoutShimDir.ORCA_AGENT_TEAMS_SHIM_DIR
    // Still a team config via CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS, but the shim
    // segment is now unprovable → drop rather than replay a poisoned PATH.
    const cleaned = stripLegacyReplayEnv(withoutShimDir, 'posix')
    expect(cleaned.PATH).toBeUndefined()
  })

  it('drops PATH when its first segment is not the captured shim dir', () => {
    const cleaned = stripLegacyReplayEnv(
      capturedTeamEnv({ PATH: '/usr/local/bin:/home/me/.orca/claude-agent-teams-bin' }),
      'posix'
    )
    expect(cleaned.PATH).toBeUndefined()
  })

  it('drops PATH entirely when the shim dir is the only segment', () => {
    const cleaned = stripLegacyReplayEnv(
      capturedTeamEnv({ PATH: '/home/me/.orca/claude-agent-teams-bin' }),
      'posix'
    )
    expect(cleaned.PATH).toBeUndefined()
  })
})
