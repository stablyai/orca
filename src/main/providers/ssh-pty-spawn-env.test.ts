import { describe, expect, it } from 'vitest'
import { buildSshPtySpawnEnv } from './ssh-pty-spawn-env'

describe('buildSshPtySpawnEnv runtime metadata', () => {
  it('publishes Bun through generic runtime fields without a Node alias', () => {
    expect(
      buildSshPtySpawnEnv({
        env: { PATH: '/usr/bin', ORCA_RELAY_NODE_PATH: '/stale/node' },
        remoteCliBridgeEnv: {
          binDir: '/home/me/.orca-relay/bin',
          relayDir: '/home/me/.orca-relay/relay-v1',
          runtimePath: '/home/me/.orca-relay/relay-v1/bun-runtime',
          runtimeKind: 'bun',
          sockPath: '/home/me/.orca-relay/relay.sock'
        }
      })
    ).toEqual({
      PATH: '/home/me/.orca-relay/bin:/usr/bin',
      ORCA_REMOTE_CLI_BIN_DIR: '/home/me/.orca-relay/bin',
      ORCA_RELAY_DIR: '/home/me/.orca-relay/relay-v1',
      ORCA_RELAY_RUNTIME_PATH: '/home/me/.orca-relay/relay-v1/bun-runtime',
      ORCA_RELAY_RUNTIME_KIND: 'bun',
      ORCA_RELAY_SOCKET_PATH: '/home/me/.orca-relay/relay.sock',
      POWERLEVEL9K_DISABLE_CONFIGURATION_WIZARD: 'true'
    })
  })

  it('keeps legacy Node-only payloads compatible', () => {
    expect(
      buildSshPtySpawnEnv({
        env: { PATH: '/usr/bin' },
        remoteCliBridgeEnv: {
          binDir: '/home/me/.orca-relay/bin',
          relayDir: '/home/me/.orca-relay/relay-v1',
          nodePath: '/usr/bin/node',
          sockPath: '/home/me/.orca-relay/relay.sock'
        }
      })
    ).toMatchObject({
      ORCA_RELAY_NODE_PATH: '/usr/bin/node'
    })
    expect(
      buildSshPtySpawnEnv({
        env: { PATH: '/usr/bin' },
        remoteCliBridgeEnv: {
          binDir: '/home/me/.orca-relay/bin',
          relayDir: '/home/me/.orca-relay/relay-v1',
          nodePath: '/usr/bin/node',
          sockPath: '/home/me/.orca-relay/relay.sock'
        }
      })
    ).not.toHaveProperty('ORCA_RELAY_RUNTIME_KIND')
  })
})
