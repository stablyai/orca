import { describe, expect, it } from 'vitest'
import { buildSshPtySpawnEnv } from './ssh-pty-spawn-env'
import type { RemoteCliBridgeEnv } from './ssh-pty-provider-contract'

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
