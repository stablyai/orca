import { describe, expect, it } from 'vitest'
import { buildSshPtySpawnEnv } from './ssh-pty-spawn-env'
import type { RemoteCliBridgeEnv } from './ssh-pty-provider-contract'

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

const bridge: RemoteCliBridgeEnv = {
  binDir: '/remote/orca/bin',
  relayDir: '/remote/orca',
  nodePath: '/remote/node',
  sockPath: '/remote/orca/socket'
}

describe('SSH CLI path ownership', () => {
  it('replaces the client restore directory with the remote bridge', () => {
    const env = { PATH: '/usr/bin', ORCA_CLI_BIN_DIR: '/client/orca/bin' }
    const result = buildSshPtySpawnEnv({ env, remoteCliBridgeEnv: bridge })
    expect(result.ORCA_CLI_BIN_DIR).toBe(bridge.binDir)
    expect(result.PATH).toBe(`${bridge.binDir}:/usr/bin`)
    expect(env.ORCA_CLI_BIN_DIR).toBe('/client/orca/bin')
  })

  it('clears a client path when no remote bridge is available', () => {
    const result = buildSshPtySpawnEnv({ env: { ORCA_CLI_BIN_DIR: '/client/orca/bin' } })
    expect(result.ORCA_CLI_BIN_DIR).toBeUndefined()
  })

  it('does not give a POSIX wrapper a Windows bridge directory', () => {
    const result = buildSshPtySpawnEnv({
      env: { Path: 'C:\\Windows', ORCA_CLI_BIN_DIR: '/client/orca/bin' },
      remoteCliBridgeEnv: { ...bridge, binDir: 'C:\\Orca\\bin', pathDelimiter: ';' }
    })
    expect(result.ORCA_CLI_BIN_DIR).toBeUndefined()
    expect(result.Path).toBe('C:\\Orca\\bin;C:\\Windows')
  })

  it('preserves an explicitly deleted restore key', () => {
    const result = buildSshPtySpawnEnv({
      env: { PATH: '/usr/bin' },
      remoteCliBridgeEnv: bridge,
      envToDelete: ['ORCA_CLI_BIN_DIR']
    })
    expect(result.ORCA_CLI_BIN_DIR).toBeUndefined()
  })
})
