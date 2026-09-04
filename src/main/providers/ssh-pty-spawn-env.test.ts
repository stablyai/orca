import { describe, expect, it } from 'vitest'
import { CODEX_SECONDARY_HOME_PROFILE_ID } from '../../shared/agent-launch-profile/agent-launch-profile'
import { AGENT_SESSION_LAUNCH_PROFILE_REMOTE_UNSUPPORTED } from '../agent-launch-profile/requested-launch-profile'
import { getRemoteHostPlatform } from '../ssh/ssh-remote-platform'
import { buildSshPtySpawnEnv } from './ssh-pty-spawn-env'

const bridge = {
  remoteHome: '/home/dev',
  hostPlatform: getRemoteHostPlatform('linux-x64'),
  binDir: '/home/dev/.orca-relay/bin',
  relayDir: '/home/dev/.orca-relay',
  nodePath: '/home/dev/.orca-relay/node',
  sockPath: '/tmp/orca.sock'
}

describe('buildSshPtySpawnEnv launch profiles', () => {
  it('resolves a secondary-home marker against the probed remote home', () => {
    const env = buildSshPtySpawnEnv({
      env: { ORCA_CODEX_HOME_PROFILE: CODEX_SECONDARY_HOME_PROFILE_ID, PATH: '/usr/bin' },
      remoteCliBridgeEnv: bridge
    })
    expect(env.CODEX_HOME).toBe('/home/dev/.codex-2')
    expect(env.ORCA_CODEX_HOME).toBe('/home/dev/.codex-2')
    expect(env.ORCA_CODEX_HOME_PROFILE).toBeUndefined()
  })

  it('fails rather than launching on the remote default home when the probe is missing', () => {
    expect(() =>
      buildSshPtySpawnEnv({
        env: { ORCA_CODEX_HOME_PROFILE: CODEX_SECONDARY_HOME_PROFILE_ID }
      })
    ).toThrow(AGENT_SESSION_LAUNCH_PROFILE_REMOTE_UNSUPPORTED)
  })
})
