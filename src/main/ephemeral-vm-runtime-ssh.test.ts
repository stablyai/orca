import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  remove: vi.fn(async () => {})
}))

vi.mock('./ssh/targets/ssh-target-registry', () => ({
  connectRegisteredSshTarget: mocks.connect
}))
vi.mock('./ipc/ssh/ssh', () => ({
  getSshConnectionStore: () => ({
    upsertRuntimeOwnedTarget: (runtimeId: string) => ({
      id: `runtime-ssh-${runtimeId}`,
      label: 'VM',
      host: 'vm',
      port: 22,
      username: 'root'
    })
  })
}))
vi.mock('./ipc/ssh/ssh-session-teardown', () => ({
  disconnectRegisteredSshTarget: vi.fn(),
  removeRegisteredSshTarget: mocks.remove
}))

import { connectRuntimeOwnedSshTarget } from './ephemeral-vm-runtime-ssh'
import { SSH_HOST_NOT_SERVED_MESSAGE } from './providers/ssh-host-not-served-error'

const connection = {
  type: 'ssh' as const,
  projectRoot: '/workspace/repo',
  target: { label: 'VM', host: 'vm', port: 22, username: 'root' }
}

describe('connectRuntimeOwnedSshTarget', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("returns the managed server a recipe VM's host runs", async () => {
    mocks.connect.mockResolvedValue({
      targetId: 'runtime-ssh-vm-1',
      status: 'connected',
      error: null,
      reconnectAttempt: 0,
      managedServer: { kind: 'managed', environmentId: 'env-vm' }
    })
    await expect(
      connectRuntimeOwnedSshTarget({ runtimeId: 'vm-1', connection })
    ).resolves.toMatchObject({ targetId: 'runtime-ssh-vm-1', environmentId: 'env-vm' })
    expect(mocks.remove).not.toHaveBeenCalled()
  })

  it('fails at once and removes the target when the host has no managed server', async () => {
    mocks.connect.mockResolvedValue({
      targetId: 'runtime-ssh-vm-1',
      status: 'connected',
      error: null,
      reconnectAttempt: 0
    })
    const started = Date.now()
    await expect(connectRuntimeOwnedSshTarget({ runtimeId: 'vm-1', connection })).rejects.toThrow(
      SSH_HOST_NOT_SERVED_MESSAGE
    )
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(mocks.remove).toHaveBeenCalledWith('runtime-ssh-vm-1')
  })
})
