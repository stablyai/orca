import { describe, expect, it } from 'vitest'
import {
  CLAUDE_SECONDARY_HOME_PROFILE_ID,
  CODEX_SECONDARY_HOME_PROFILE_ID
} from '../../shared/agent-launch-profile/agent-launch-profile'
import { getRemoteHostPlatform } from '../ssh/ssh-remote-platform'
import { applyLaunchProfileHomeMarkersForRemoteHost } from './launch-profile-remote-home'
import { AGENT_SESSION_LAUNCH_PROFILE_REMOTE_UNSUPPORTED } from './requested-launch-profile'

describe('applyLaunchProfileHomeMarkersForRemoteHost', () => {
  it('joins the probed remote home in the host path flavor and mirrors Codex', () => {
    const env: Record<string, string> = {
      ORCA_CODEX_HOME_PROFILE: CODEX_SECONDARY_HOME_PROFILE_ID,
      CODEX_HOME: '/ignored/managed'
    }
    applyLaunchProfileHomeMarkersForRemoteHost(env, {
      remoteHome: '/home/dev',
      hostPlatform: getRemoteHostPlatform('linux-x64')
    })
    expect(env).toEqual({ CODEX_HOME: '/home/dev/.codex-2', ORCA_CODEX_HOME: '/home/dev/.codex-2' })
  })

  it('uses the Windows flavor for a Windows remote and leaves Claude unmirrored', () => {
    const env: Record<string, string> = {
      ORCA_CLAUDE_CONFIG_DIR_PROFILE: CLAUDE_SECONDARY_HOME_PROFILE_ID
    }
    applyLaunchProfileHomeMarkersForRemoteHost(env, {
      remoteHome: 'C:\\Users\\dev',
      hostPlatform: getRemoteHostPlatform('win32-x64')
    })
    expect(Object.keys(env)).toEqual(['CLAUDE_CONFIG_DIR'])
    expect(env.CLAUDE_CONFIG_DIR).toMatch(/Users\/dev\/\.claude-2$/)
  })

  it('fails the launch when the remote home was never probed', () => {
    const env = { ORCA_CODEX_HOME_PROFILE: CODEX_SECONDARY_HOME_PROFILE_ID }
    expect(() => applyLaunchProfileHomeMarkersForRemoteHost(env, undefined)).toThrow(
      AGENT_SESSION_LAUNCH_PROFILE_REMOTE_UNSUPPORTED
    )
    expect(() =>
      applyLaunchProfileHomeMarkersForRemoteHost({ ...env }, { remoteHome: '/home/dev' })
    ).toThrow(AGENT_SESSION_LAUNCH_PROFILE_REMOTE_UNSUPPORTED)
  })

  it('leaves a launch without markers untouched even without a probe', () => {
    const env = { CODEX_HOME: '/home/dev/.codex' }
    applyLaunchProfileHomeMarkersForRemoteHost(env, undefined)
    expect(env).toEqual({ CODEX_HOME: '/home/dev/.codex' })
  })
})
