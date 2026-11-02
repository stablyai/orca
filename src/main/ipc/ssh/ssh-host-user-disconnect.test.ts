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
vi.mock('../../ssh/ssh-connection-store', () => mocks.sshConnectionStore)
vi.mock('./ssh-host-server-connect', () => mocks.hostServerConnect)
vi.mock('../../ssh/ssh-connection-manager', () => mocks.sshConnectionManager)
vi.mock('../../ssh/ssh-channel-multiplexer', () => mocks.sshChannelMultiplexer)
vi.mock('../../ssh/port-forwarding/ssh-port-forward', () => mocks.sshPortForward)
vi.mock('../ssh/ssh-port-scanner', () => mocks.sshPortScanner)
vi.mock('../../../shared/runtime-environment-store', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  listEnvironments: () => runtime.environments
}))
vi.mock(
  '../runtime-environments/runtime-environment-request-connections',
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    getRuntimeEnvironmentStatusOwner: runtime.getStatusOwner
  })
)
vi.mock('../runtime-environments/runtime-environments', () => ({
  invalidateRuntimeEnvironmentTransport: runtime.invalidate
}))

import type { SshConnectionState, SshTarget } from '../../../shared/ssh-types'
import {
  clearRuntimeEnvironmentManualDisconnect,
  isRuntimeEnvironmentManuallyDisconnected
} from '../runtime-environments/runtime-environment-manual-disconnect'
import { isSshUserDisconnected } from '../../ssh/ssh-user-disconnect'
import { createSshIpcHarness } from './ssh-ipc-test-harness'

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
    expect(mockConnectionManager.connect).not.toHaveBeenCalled()
    expect(isSshUserDisconnected(target.id)).toBe(true)
  })

  it("also stops the managed server's status checks, which would redial the host", async () => {
    await disconnect()

    expect(isRuntimeEnvironmentManuallyDisconnected(managedServer.id)).toBe(true)
    expect(runtime.invalidate).toHaveBeenCalledWith(managedServer.id)
    expect(isRuntimeEnvironmentManuallyDisconnected(otherServer.id)).toBe(false)
  })

  /** Settings' Connect; the server decision is mocked, so only the lift matters here. */
  async function connectExplicitly(): Promise<void> {
    await Promise.resolve(handlers.get('ssh:connect')!(null, { targetId: target.id })).catch(
      () => {}
    )
  }

  it('is not re-applied by its own cleanup when a Connect follows at once', async () => {
    const disconnecting = disconnect()
    const connecting = connectExplicitly()
    await Promise.all([disconnecting, connecting])

    expect(isSshUserDisconnected(target.id)).toBe(false)
    expect(isRuntimeEnvironmentManuallyDisconnected(managedServer.id)).toBe(false)
    expect(runtime.invalidate).not.toHaveBeenCalled()
  })

  it('is lifted, with its server, by an explicit Connect, whose status checks resume after', async () => {
    await disconnect()
    mockConnectionManager.connect.mockResolvedValue({})
    const { publishManagedServerConnect } = await import('./ssh-host-server-connect')
    const connected: SshConnectionState = {
      targetId: target.id,
      status: 'connected',
      error: null,
      reconnectAttempt: 0
    }
    vi.mocked(publishManagedServerConnect).mockReturnValue(connected)

    await connectExplicitly()

    expect(isSshUserDisconnected(target.id)).toBe(false)
    expect(isRuntimeEnvironmentManuallyDisconnected(managedServer.id)).toBe(false)
    expect(runtime.activate).toHaveBeenCalledTimes(1)
  })

  it('still lets the user test the connection, which leaves it disconnected', async () => {
    await disconnect()
    mockConnectionManager.connect.mockResolvedValue({
      getState: () => ({ targetId: target.id, status: 'connected', error: null })
    })

    await handlers.get('ssh:testConnection')!(null, { targetId: target.id })

    expect(mockConnectionManager.connect).toHaveBeenCalledWith(target, { probe: true })
    expect(isSshUserDisconnected(target.id)).toBe(true)
    expect(isRuntimeEnvironmentManuallyDisconnected(managedServer.id)).toBe(true)
  })
})
