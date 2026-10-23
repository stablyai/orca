import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const hoisted = vi.hoisted(() => {
  const environment: Record<string, unknown> = {}
  return {
    handlers: new Map<string, (event: unknown, args: unknown) => unknown>(),
    environment,
    teardown: vi.fn(),
    invalidate: vi.fn(),
    connectHost: vi.fn()
  }
})

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, args: unknown) => unknown) =>
      hoisted.handlers.set(channel, handler)
  }
}))
vi.mock('../../../shared/runtime-environment-store', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveEnvironment: () => hoisted.environment,
  listEnvironments: () => [hoisted.environment]
}))
vi.mock('./runtime-environment-request-connections', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getRuntimeEnvironmentStatusOwner: () => ({ activate: vi.fn() }),
  closeRemoteRuntimeRequestConnection: vi.fn()
}))
vi.mock('./runtime-environment-host-service-ops', () => ({
  connectThroughOwningService: vi.fn(async () => {}),
  removeThroughOwningService: vi.fn()
}))
vi.mock('./runtime-environment-transport-routing', () => ({ callRuntimeEnvironment: vi.fn() }))
vi.mock('./runtime-environment-status-probe', () => ({
  getRuntimeEnvironmentStatus: vi.fn(async () => ({ ok: true }))
}))
vi.mock('../ssh/ssh-session-teardown', () => ({ disconnectRegisteredSshTarget: hoisted.teardown }))
vi.mock('../../ssh/targets/ssh-target-registry', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  connectRegisteredSshTarget: hoisted.connectHost
}))

import { registerRuntimeEnvironmentConnectivityHandlers } from './runtime-environment-connectivity-handlers'
import {
  clearRuntimeEnvironmentManualDisconnect,
  isRuntimeEnvironmentManuallyDisconnected
} from './runtime-environment-manual-disconnect'
import {
  isSshUserDisconnected,
  resetSshUserDisconnectsForTests
} from '../../ssh/ssh-user-disconnect'

const deployment = {
  kind: 'ssh',
  requestId: 'request-1',
  sshTargetId: 'ssh-1',
  sshTargetGeneration: 1,
  localPort: 41000,
  remotePort: 6768
}

describe("the status bar's Disconnect of a server", () => {
  beforeEach(() => {
    hoisted.handlers.clear()
    hoisted.teardown.mockReset().mockResolvedValue(undefined)
    hoisted.invalidate.mockReset()
    hoisted.connectHost.mockReset().mockResolvedValue(undefined)
    resetSshUserDisconnectsForTests()
    registerRuntimeEnvironmentConnectivityHandlers({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these handlers read only store.getSettings(), which this stub provides.
      store: { getSettings: () => ({}) } as never,
      getUserDataPath: () => '/tmp/orca-user-data',
      invalidateTransport: hoisted.invalidate
    })
  })

  afterEach(() => {
    clearRuntimeEnvironmentManualDisconnect('env-1')
  })

  function invoke(channel: string): Promise<unknown> {
    return Promise.resolve(hoisted.handlers.get(channel)!(null, { selector: 'env-1' }))
  }

  it('also disconnects the SSH host a managed server runs on, so Settings agrees', async () => {
    hoisted.environment = { id: 'env-1', endpoints: [], orcadDeployment: deployment }

    await invoke('runtimeEnvironments:disconnect')

    expect(isRuntimeEnvironmentManuallyDisconnected('env-1')).toBe(true)
    expect(hoisted.teardown).toHaveBeenCalledWith('ssh-1')
    expect(isSshUserDisconnected('ssh-1')).toBe(true)
    expect(hoisted.invalidate).toHaveBeenCalledTimes(1)
  })

  it('leaves SSH alone for a server that is not managed over SSH', async () => {
    hoisted.environment = { id: 'env-1', endpoints: [] }

    await invoke('runtimeEnvironments:disconnect')

    expect(hoisted.teardown).not.toHaveBeenCalled()
    expect(isSshUserDisconnected('ssh-1')).toBe(false)
  })

  it("is lifted by the status bar's Connect, through the host's own Connect", async () => {
    hoisted.environment = { id: 'env-1', endpoints: [], orcadDeployment: deployment }
    await invoke('runtimeEnvironments:disconnect')

    await invoke('runtimeEnvironments:connect')

    expect(isRuntimeEnvironmentManuallyDisconnected('env-1')).toBe(false)
    // That connect republishes the managed verdict and restores the host's port forwards.
    expect(hoisted.connectHost).toHaveBeenCalledWith('ssh-1')
  })

  it('reconnects a server whose host the user never disconnected without dialing the host', async () => {
    hoisted.environment = { id: 'env-1', endpoints: [], orcadDeployment: deployment }

    await invoke('runtimeEnvironments:connect')

    expect(hoisted.connectHost).not.toHaveBeenCalled()
  })
})
