import { describe, expect, it } from 'vitest'
import {
  applyAgentTeamsProbeShellEnv,
  promoteAgentTeamsShimPath
} from './claude-agent-teams-spawn-env'

const IT2_DIR = '/tmp/orca-it2-shim'
const TMUX_DIR = '/tmp/orca-tmux-shim'
const PROBE_SHELL = '/tmp/orca-it2-shim/probe-shell'

describe('promoteAgentTeamsShimPath', () => {
  it('keeps promoting only the first requested entry without an it2 shim dir', () => {
    const env = {
      ORCA_AGENT_TEAMS_TEAM_ID: 'team-test',
      ORCA_AGENT_TEAMS_SHIM_DIR: TMUX_DIR,
      PATH: `/usr/bin:${TMUX_DIR}:/bin`
    }

    promoteAgentTeamsShimPath(env, `${TMUX_DIR}:/usr/bin`)

    expect(env.PATH).toBe(`${TMUX_DIR}:/usr/bin:/bin`)
  })

  it('leads PATH with the it2 dir, then the tmux dir', () => {
    const env = {
      ORCA_AGENT_TEAMS_TEAM_ID: 'team-test',
      ORCA_AGENT_TEAMS_SHIM_DIR: TMUX_DIR,
      ORCA_AGENT_TEAMS_IT2_SHIM_DIR: IT2_DIR,
      PATH: `/opt/host-injected:${TMUX_DIR}:${IT2_DIR}:/usr/bin`
    }

    promoteAgentTeamsShimPath(env, `${IT2_DIR}:${TMUX_DIR}:/usr/bin`)

    expect(env.PATH).toBe(`${IT2_DIR}:${TMUX_DIR}:/opt/host-injected:/usr/bin`)
  })

  it('promotes both dirs when host injection slid an entry between them', () => {
    const env = {
      ORCA_AGENT_TEAMS_TEAM_ID: 'team-test',
      ORCA_AGENT_TEAMS_SHIM_DIR: TMUX_DIR,
      ORCA_AGENT_TEAMS_IT2_SHIM_DIR: IT2_DIR,
      PATH: `/usr/bin:${TMUX_DIR}:/opt/host-injected:${IT2_DIR}`
    }

    promoteAgentTeamsShimPath(env, `${IT2_DIR}:/opt/host-injected:${TMUX_DIR}:/usr/bin`)

    expect(env.PATH).toBe(`${IT2_DIR}:${TMUX_DIR}:/usr/bin:/opt/host-injected`)
  })

  it('leaves PATH alone without a team id', () => {
    const env = { ORCA_AGENT_TEAMS_IT2_SHIM_DIR: IT2_DIR, PATH: '/usr/bin' }

    promoteAgentTeamsShimPath(env, `${IT2_DIR}:/usr/bin`)

    expect(env.PATH).toBe('/usr/bin')
  })
})

describe('applyAgentTeamsProbeShellEnv', () => {
  const requestedEnv = { ORCA_AGENT_TEAMS_IT2_PROBE_SHELL: PROBE_SHELL }

  it('maps SHELL to the probe and records the real shell for the probe to exec', () => {
    const env: Record<string, string> = {
      SHELL: '/bin/zsh',
      ORCA_AGENT_TEAMS_IT2_PROBE_SHELL: PROBE_SHELL
    }

    applyAgentTeamsProbeShellEnv({ env, requestedEnv, realShellPath: '/bin/zsh' })

    expect(env).toMatchObject({
      SHELL: PROBE_SHELL,
      ORCA_AGENT_TEAMS_REAL_SHELL: '/bin/zsh',
      CLAUDE_CODE_SHELL: '/bin/zsh'
    })
  })

  it('drops it2 vars inherited from a parent Orca pane when the request carried none', () => {
    const inherited = (): Record<string, string> => ({
      SHELL: '/bin/zsh',
      ORCA_AGENT_TEAMS_IT2_PROBE_SHELL: PROBE_SHELL,
      ORCA_AGENT_TEAMS_IT2_SHIM_DIR: IT2_DIR
    })

    for (const request of [{}, undefined]) {
      const env = inherited()
      applyAgentTeamsProbeShellEnv({ env, requestedEnv: request, realShellPath: '/bin/zsh' })
      expect(env).toEqual({ SHELL: '/bin/zsh' })
    }
  })

  it('does nothing on Windows', () => {
    const env: Record<string, string> = {
      SHELL: '/bin/zsh',
      ORCA_AGENT_TEAMS_IT2_PROBE_SHELL: PROBE_SHELL
    }

    applyAgentTeamsProbeShellEnv({
      env,
      requestedEnv,
      realShellPath: '/bin/zsh',
      platform: 'win32'
    })

    expect(env.SHELL).toBe('/bin/zsh')
    expect(env.ORCA_AGENT_TEAMS_REAL_SHELL).toBeUndefined()
  })

  it('keeps a CLAUDE_CODE_SHELL the user chose', () => {
    const env: Record<string, string> = {
      SHELL: '/bin/zsh',
      CLAUDE_CODE_SHELL: '/opt/homebrew/bin/bash',
      ORCA_AGENT_TEAMS_IT2_PROBE_SHELL: PROBE_SHELL
    }

    applyAgentTeamsProbeShellEnv({ env, requestedEnv, realShellPath: '/bin/zsh' })

    expect(env.CLAUDE_CODE_SHELL).toBe('/opt/homebrew/bin/bash')
  })

  it('leaves CLAUDE_CODE_SHELL unset when the real shell is not bash or zsh', () => {
    const env: Record<string, string> = {
      SHELL: '/usr/bin/fish',
      ORCA_AGENT_TEAMS_IT2_PROBE_SHELL: PROBE_SHELL
    }

    applyAgentTeamsProbeShellEnv({ env, requestedEnv, realShellPath: '/usr/bin/fish' })

    expect(env.SHELL).toBe(PROBE_SHELL)
    expect(env.ORCA_AGENT_TEAMS_REAL_SHELL).toBe('/usr/bin/fish')
    expect(env.CLAUDE_CODE_SHELL).toBeUndefined()
  })

  it('replaces its own mapping when the spawn falls back to another shell', () => {
    const env: Record<string, string> = {
      SHELL: '/opt/missing/zsh',
      ORCA_AGENT_TEAMS_IT2_PROBE_SHELL: PROBE_SHELL
    }

    applyAgentTeamsProbeShellEnv({ env, requestedEnv, realShellPath: '/opt/missing/zsh' })
    applyAgentTeamsProbeShellEnv({ env, requestedEnv, realShellPath: '/bin/bash' })

    expect(env).toMatchObject({
      SHELL: PROBE_SHELL,
      ORCA_AGENT_TEAMS_REAL_SHELL: '/bin/bash',
      CLAUDE_CODE_SHELL: '/bin/bash'
    })
  })

  it('drops its own CLAUDE_CODE_SHELL when the fallback shell is not bash or zsh', () => {
    const env: Record<string, string> = {
      SHELL: '/bin/zsh',
      ORCA_AGENT_TEAMS_IT2_PROBE_SHELL: PROBE_SHELL
    }

    applyAgentTeamsProbeShellEnv({ env, requestedEnv, realShellPath: '/bin/zsh' })
    applyAgentTeamsProbeShellEnv({ env, requestedEnv, realShellPath: '/bin/sh' })

    expect(env.CLAUDE_CODE_SHELL).toBeUndefined()
  })
})
