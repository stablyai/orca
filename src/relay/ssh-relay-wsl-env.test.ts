import { describe, expect, it } from 'vitest'
import { addSshRelayWslEnv, isWindowsWslShell } from './ssh-relay-wsl-env'

describe('SSH relay WSL environment', () => {
  it.each(['wsl.exe', 'WSL', 'C:\\Windows\\System32\\wsl.exe'])(
    'recognizes %s as WSL',
    (shellPath) => {
      expect(isWindowsWslShell(shellPath)).toBe(true)
    }
  )

  it('passes launcher paths bidirectionally and preserves the named pipe verbatim', () => {
    const env: Record<string, string> = {
      ORCA_CLI_COMMAND: 'C:/Users/me/.orca-relay/bin/orca-relay.exe',
      ORCA_REMOTE_CLI_BIN_DIR: 'C:/Users/me/.orca-relay/bin',
      ORCA_RELAY_DIR: 'C:/Users/me/.orca-remote/relay-v1',
      ORCA_RELAY_NODE_PATH: 'C:/Program Files/nodejs/node.exe',
      ORCA_RELAY_SOCKET_PATH: '\\\\.\\pipe\\orca-relay-123'
    }

    addSshRelayWslEnv(env)

    expect(env.WSLENV?.split(':')).toEqual([
      'ORCA_CLI_COMMAND/p',
      'ORCA_REMOTE_CLI_BIN_DIR/p',
      'ORCA_RELAY_DIR/p',
      'ORCA_RELAY_NODE_PATH/p',
      'ORCA_RELAY_SOCKET_PATH'
    ])
  })

  it('deduplicates managed entries while preserving unrelated WSLENV entries', () => {
    const env = {
      WSLENV: 'KEEP_ME:ORCA_CLI_COMMAND/u:ORCA_RELAY_SOCKET_PATH/up:KEEP_PATH/p',
      ORCA_CLI_COMMAND: 'C:/relay/orca-relay.exe',
      ORCA_RELAY_SOCKET_PATH: '\\\\.\\pipe\\orca'
    }

    addSshRelayWslEnv(env)

    expect(env.WSLENV.split(':')).toEqual([
      'KEEP_ME',
      'ORCA_CLI_COMMAND/p',
      'ORCA_RELAY_SOCKET_PATH',
      'KEEP_PATH/p'
    ])
  })

  it('does not advertise absent bridge variables', () => {
    const env = { WSLENV: 'KEEP_ME' }

    addSshRelayWslEnv(env)

    expect(env.WSLENV).toBe('KEEP_ME')
  })
})
