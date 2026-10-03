import { describe, expect, it } from 'vitest'
import { buildSshPtySpawnEnv } from './ssh-pty-spawn-env'

describe('buildSshPtySpawnEnv relay bridge', () => {
  it('prepends the CLI bin dir once and publishes the Node relay bridge', () => {
    const env = buildSshPtySpawnEnv({
      env: { PATH: '/home/me/.orca-relay/bin:/usr/bin' },
      remoteCliBridgeEnv: {
        binDir: '/home/me/.orca-relay/bin',
        relayDir: '/home/me/.orca-relay/relay-v1',
        nodePath: '/usr/bin/node',
        sockPath: '/home/me/.orca-relay/relay.sock'
      }
    })

    expect(env).toMatchObject({
      PATH: '/home/me/.orca-relay/bin:/usr/bin',
      ORCA_REMOTE_CLI_BIN_DIR: '/home/me/.orca-relay/bin',
      ORCA_RELAY_DIR: '/home/me/.orca-relay/relay-v1',
      ORCA_RELAY_NODE_PATH: '/usr/bin/node',
      ORCA_RELAY_SOCKET_PATH: '/home/me/.orca-relay/relay.sock'
    })
    expect(env).not.toHaveProperty('ORCA_RELAY_CREDENTIAL_FILE')
  })
})
