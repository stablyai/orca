import { EventEmitter } from 'node:events'
import type { ClientChannel } from 'ssh2'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SshConnection } from '../ssh/ssh-connection'

vi.mock('../ssh/ssh-remote-platform-detection', () => ({
  detectRemoteHostPlatform: vi.fn().mockResolvedValue({
    os: 'linux',
    arch: 'x64',
    relayPlatform: 'linux-x64',
    pathSeparator: '/',
    homeVariable: '$HOME'
  })
}))

vi.mock('./herdr-binary-source', () => ({
  verifyManagedHerdrExecutable: vi.fn(() => ({ sourceCommit: 'abc123' }))
}))

import { ensureManagedHerdrOnSsh } from './herdr-managed-ssh-provisioner'

function createHangingChannel(): ClientChannel & { close: ReturnType<typeof vi.fn> } {
  return Object.assign(new EventEmitter(), {
    stderr: new EventEmitter(),
    close: vi.fn()
  }) as unknown as ClientChannel & { close: ReturnType<typeof vi.fn> }
}

describe('managed Herdr SSH provisioning', () => {
  afterEach(() => vi.useRealTimers())

  it('closes and rejects a remote provisioning command that exceeds its deadline', async () => {
    vi.useFakeTimers()
    const channel = createHangingChannel()
    const connection = {
      exec: vi.fn().mockResolvedValue(channel)
    } as unknown as SshConnection

    const provisioning = ensureManagedHerdrOnSsh(connection, '/resources')
    const rejection = expect(provisioning).rejects.toThrow(
      'Remote Herdr provisioning command timed out after 15000ms'
    )
    await vi.advanceTimersByTimeAsync(15_000)

    await rejection
    expect(channel.close).toHaveBeenCalledTimes(1)
  })
})
