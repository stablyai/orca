import { describe, expect, it, vi } from 'vitest'
import { getRemoteHostPlatform } from '../ssh/ssh-remote-platform'
import { SshPtyProvider } from './ssh-pty-provider'

function createMultiplexer() {
  return {
    request: vi.fn(),
    notify: vi.fn(),
    onNotification: vi.fn(),
    dispose: vi.fn(),
    isDisposed: vi.fn(() => false)
  }
}

describe('SSH PTY reservation path flavor', () => {
  it('uses relay platform detection when CLI bridge env is complete', () => {
    const provider = new SshPtyProvider('conn-relay', createMultiplexer() as never, {
      binDir: '/home/user/.orca-relay/bin',
      relayDir: '/home/user/.orca-relay/relay-v1',
      nodePath: '/usr/bin/node',
      sockPath: '/home/user/.orca-relay/relay.sock',
      hostPlatform: getRemoteHostPlatform('linux-x64')
    })

    expect(provider.getExecutionHostPathFlavor()).toBe('posix')
  })

  it('uses direct SSH platform detection when CLI bridge env is incomplete', () => {
    const provider = new SshPtyProvider(
      'conn-direct',
      createMultiplexer() as never,
      undefined,
      1,
      'windows'
    )

    expect(provider.getExecutionHostPathFlavor()).toBe('windows')
  })
})
