import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = await vi.hoisted(async () => {
  const { createSshIpcMocks } = await import('./ssh-ipc-module-mocks')
  return createSshIpcMocks()
})
const runtime = vi.hoisted(() => {
  const environments: unknown[] = []
  return { environments, activate: vi.fn(), getStatusOwner: vi.fn(), invalidate: vi.fn() }
})

vi.mock('../../ssh/config/ssh-config-host-picker', () => mocks.sshConfigHostPicker)
vi.mock('electron', () => mocks.electron)
vi.mock('../../ssh/targets/ssh-connection-store', () => mocks.sshConnectionStore)
vi.mock('./ssh-host-server-connect', () => mocks.hostServerConnect)
vi.mock('../../ssh/connection/ssh-connection-manager', () => mocks.sshConnectionManager)
vi.mock('../../ssh/protocol/ssh-channel-multiplexer', () => mocks.sshChannelMultiplexer)
vi.mock('../../ssh/port-forwarding/ssh-port-forward', () => mocks.sshPortForward)
vi.mock('../ssh/ssh-port-scanner', () => mocks.sshPortScanner)
vi.mock(
  '../../../shared/remote-runtime/host-store/runtime-environment-store',
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    listEnvironments: () => runtime.environments
  })
)
vi.mock(
  '../runtime-environments/connections/runtime-environment-request-connections',
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    getRuntimeEnvironmentStatusOwner: runtime.getStatusOwner
  })
)
vi.mock('../runtime-environments/runtime-environments', () => ({
  invalidateRuntimeEnvironmentTransport: runtime.invalidate
}))
import type { SshTarget } from '../../../shared/ssh-types'
import { clearRuntimeEnvironmentManualDisconnect } from '../runtime-environments/connectivity/runtime-environment-manual-disconnect'
import { isSshUserDisconnected } from '../../ssh/connection/ssh-user-disconnect'
import { createSshIpcHarness } from './ssh-ipc-test-harness'
import { runTargetLifecycle } from './ssh-target-lifecycle-queue'

const { mockSshStore, mockConnectionManager } = mocks

const target: SshTarget = {
  id: 'ssh-1',
  label: 'Server',
  host: 'example.com',
  port: 22,
  username: 'deploy'
}
const managedServer = {
  id: 'env-managed',
  orcadDeployment: {
    kind: 'ssh',
    requestId: 'request-1',
    sshTargetId: 'ssh-1',
    sshTargetGeneration: 1,
    localPort: 41000,
    remotePort: 6768
  }
}
const otherServer = { id: 'env-other' }

describe('a user Disconnect of an SSH host', () => {
  const harness = createSshIpcHarness(mocks)
  const { handlers } = harness

  beforeEach(async () => {
    await harness.reset()
    runtime.environments = [managedServer, otherServer]
    runtime.getStatusOwner.mockReset().mockReturnValue({ activate: runtime.activate })
    runtime.activate.mockReset()
    runtime.invalidate.mockReset()
    mockSshStore.getTarget.mockReturnValue(target)
    mockConnectionManager.disconnect.mockResolvedValue(undefined)
  })

  afterEach(() => {
    clearRuntimeEnvironmentManualDisconnect(managedServer.id)
    clearRuntimeEnvironmentManualDisconnect(otherServer.id)
  })

  async function disconnect(): Promise<void> {
    await handlers.get('ssh:disconnect')!(null, { targetId: target.id })
  }

  it('is not undone by a background connect such as a pane or automation restore', async () => {
    await disconnect()

    await expect(
      handlers.get('ssh:connect')!(null, { targetId: target.id, automatic: true })
    ).rejects.toThrow('Server was disconnected. Connect to use it again.')
    expect(isSshUserDisconnected(target.id)).toBe(true)
  })
})

describe('a host whose managed server the user stopped and removed', () => {
  const harness = createSshIpcHarness(mocks)
  const { handlers } = harness
  const removed: SshTarget = {
    ...target,
    managedServerRemoved: { removedAt: '2026-10-26T00:00:00Z' }
  }

  beforeEach(async () => {
    await harness.reset()
    runtime.environments = [otherServer]
    mockSshStore.getTarget.mockReturnValue(removed)
  })

  it('holds a reconnect that queued behind the Stop that wrote the hold', async () => {
    mockSshStore.getTarget.mockReturnValue(target)
    let finishStop!: () => void
    const stopping = runTargetLifecycle(
      target.id,
      () => new Promise<void>((resolve) => (finishStop = resolve))
    )
    const reconnect = Promise.resolve(
      handlers.get('ssh:connect')!(null, { targetId: target.id, automatic: true })
    )
    mockSshStore.getTarget.mockReturnValue(removed)
    finishStop()
    await stopping

    await expect(reconnect).rejects.toThrow('Server was disconnected. Connect to use it again.')
  })
})
