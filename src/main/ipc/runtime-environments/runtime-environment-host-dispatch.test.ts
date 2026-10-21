import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Pins what connect and remove do for each kind of host, so host-kind dispatch stays exhaustive.
type WslServiceFake = { connect: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn> }

const mocks = vi.hoisted(() => {
  const order: string[] = []
  const wsl: { service: WslServiceFake | null } = { service: null }
  return {
    order,
    handle: vi.fn(),
    resolveEnvironment: vi.fn(),
    removeEnvironment: vi.fn(),
    retire: vi.fn(),
    closeRequest: vi.fn(),
    getStatus: vi.fn(),
    clearDecline: vi.fn(),
    wsl
  }
})

vi.mock('electron', () => ({ ipcMain: { handle: mocks.handle } }))
vi.mock('../../../shared/runtime-environment-store', () => ({
  addEnvironmentFromPairingCode: vi.fn(),
  listEnvironments: vi.fn(() => []),
  removeEnvironment: mocks.removeEnvironment,
  resolveEnvironment: mocks.resolveEnvironment
}))
vi.mock('./runtime-environment-removal-cleanup', () => ({
  retireRemovedRuntimeEnvironment: mocks.retire
}))
vi.mock('./runtime-environment-request-connections', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  closeRemoteRuntimeRequestConnection: mocks.closeRequest
}))
vi.mock('./runtime-environment-transport-routing', () => ({ callRuntimeEnvironment: vi.fn() }))
vi.mock('./runtime-environment-status-probe', () => ({
  getRuntimeEnvironmentStatus: mocks.getStatus
}))
vi.mock('../../ssh/ssh-credential-decline', () => ({
  clearSshCredentialDeclinedForEnvironment: mocks.clearDecline
}))
vi.mock('../../wsl/wsl-host-service-instance', () => ({
  getWslHostService: () => mocks.wsl.service
}))

import { registerRuntimeEnvironmentConnectivityHandlers } from './runtime-environment-connectivity-handlers'
import { WSL_HOSTS_GATED_OFF_MESSAGE } from '../../wsl/wsl-host-gate'
import { WSL_HOSTS_INTERNAL_GATE_ENV } from '../../../shared/wsl-host-internal-gate'

const endpoints = [
  {
    id: 'ws-1',
    kind: 'websocket',
    label: 'WebSocket',
    endpoint: 'ws://h',
    deviceToken: 't',
    publicKeyB64: 'k'
  }
]
const HOSTS = {
  paired: { id: 'paired-1', name: 'Box', runtimeId: 'r', endpoints },
  sshManagedLegacy: {
    id: 'ssh-legacy',
    name: 'Legacy',
    runtimeId: 'r',
    endpoints,
    orcadDeployment: {
      sshTargetId: 't1',
      sshTargetGeneration: 1,
      localPort: 4100,
      remotePort: 6768
    }
  },
  sshManaged: {
    id: 'ssh-1',
    name: 'Managed',
    runtimeId: 'r',
    endpoints,
    orcadDeployment: {
      kind: 'ssh',
      sshTargetId: 't1',
      sshTargetGeneration: 1,
      localPort: 4100,
      remotePort: 6768
    }
  },
  sshAccess: {
    id: 'access-1',
    name: 'Access',
    runtimeId: 'r',
    endpoints,
    sshAccess: {
      sshTargetId: 't2',
      sshTargetGeneration: 1,
      localPort: 4200,
      remotePort: 6768,
      endpointId: 'ws-1',
      previousPreferredEndpointId: 'ws-0'
    }
  },
  wsl: {
    id: 'wsl:ubuntu',
    name: 'Ubuntu (WSL)',
    runtimeId: 'r',
    endpoints,
    orcadDeployment: { kind: 'wsl', distro: 'Ubuntu', localPort: 42000, remotePort: 6768 }
  }
} as const
type HostName = keyof typeof HOSTS
const NETWORK_HOSTS: HostName[] = ['paired', 'sshManagedLegacy', 'sshManaged', 'sshAccess']

const redacted = (name: HostName) => ({
  ...HOSTS[name],
  endpoints: [{ id: 'ws-1', kind: 'websocket', label: 'WebSocket', endpoint: 'ws://h' }]
})

function handler(channel: string): (event: unknown, args: Record<string, unknown>) => unknown {
  const call = mocks.handle.mock.calls.find(([name]) => name === channel)
  expect(call).toBeTruthy()
  return call![1]
}

function register(activeRuntimeEnvironmentId?: string): void {
  registerRuntimeEnvironmentConnectivityHandlers({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: connect and remove read only settings.
    store: { getSettings: () => ({ activeRuntimeEnvironmentId }) } as never,
    getUserDataPath: () => '/u',
    invalidateTransport: vi.fn()
  })
}

function useHost(name: HostName): void {
  mocks.resolveEnvironment.mockReturnValue(HOSTS[name])
  mocks.removeEnvironment.mockReturnValue(HOSTS[name])
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.order.length = 0
  vi.stubEnv(WSL_HOSTS_INTERNAL_GATE_ENV, '1')
  mocks.wsl.service = {
    // Why a macrotask: a dropped await would let getStatus run first and reorder the log.
    connect: vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
      mocks.order.push('wsl.connect')
    }),
    remove: vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
      mocks.order.push('wsl.remove')
    })
  }
  mocks.clearDecline.mockImplementation(() => mocks.order.push('clearDecline'))
  mocks.getStatus.mockImplementation(async () => {
    mocks.order.push('getStatus')
    return { id: 'status.get', ok: true, result: {}, _meta: { runtimeId: 'r' } }
  })
  register()
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('runtimeEnvironments:connect by host kind', () => {
  it('connects a WSL host through its service before asking for status', async () => {
    useHost('wsl')
    await handler('runtimeEnvironments:connect')(null, { selector: 'wsl:ubuntu', timeoutMs: 5 })
    expect(mocks.wsl.service!.connect).toHaveBeenCalledWith('wsl:ubuntu')
    expect(mocks.order).toEqual(['clearDecline', 'wsl.connect', 'getStatus'])
    expect(mocks.getStatus).toHaveBeenCalledWith('/u', 'wsl:ubuntu', 5, { reconnect: true })
  })

  it('still asks a WSL host for status when no service exists', async () => {
    useHost('wsl')
    mocks.wsl.service = null
    await handler('runtimeEnvironments:connect')(null, { selector: 'wsl:ubuntu' })
    expect(mocks.order).toEqual(['clearDecline', 'getStatus'])
  })

  it('refuses a WSL host with the gate closed before touching anything', async () => {
    useHost('wsl')
    vi.stubEnv(WSL_HOSTS_INTERNAL_GATE_ENV, '')
    await expect(
      handler('runtimeEnvironments:connect')(null, { selector: 'wsl:ubuntu' })
    ).rejects.toThrow(WSL_HOSTS_GATED_OFF_MESSAGE)
    expect(mocks.order).toEqual([])
  })

  it.each(NETWORK_HOSTS)('only asks a %s host for status', async (name) => {
    useHost(name)
    await handler('runtimeEnvironments:connect')(null, { selector: HOSTS[name].id })
    expect(mocks.wsl.service!.connect).not.toHaveBeenCalled()
    expect(mocks.clearDecline).toHaveBeenCalledWith(HOSTS[name])
    expect(mocks.order).toEqual(['clearDecline', 'getStatus'])
  })
})

describe('runtimeEnvironments:remove by host kind', () => {
  it('hands a WSL host to its service and reports the resolved record', async () => {
    useHost('wsl')
    const result = handler('runtimeEnvironments:remove')(null, { selector: 'wsl:ubuntu' })
    expect(result).toBeInstanceOf(Promise)
    await expect(result).resolves.toEqual({ removed: redacted('wsl') })
    expect(mocks.wsl.service!.remove).toHaveBeenCalledWith('wsl:ubuntu')
    expect(mocks.removeEnvironment).not.toHaveBeenCalled()
    expect(mocks.retire).not.toHaveBeenCalled()
  })

  it('removes a WSL host generically when no service exists', () => {
    useHost('wsl')
    mocks.wsl.service = null
    expect(handler('runtimeEnvironments:remove')(null, { selector: 'Ubuntu (WSL)' })).toEqual({
      removed: redacted('wsl')
    })
    expect(mocks.removeEnvironment).toHaveBeenCalledWith('/u', 'Ubuntu (WSL)')
    expect(mocks.closeRequest).toHaveBeenCalledWith('Ubuntu (WSL)')
  })

  it('refuses a WSL host with the gate closed', () => {
    useHost('wsl')
    vi.stubEnv(WSL_HOSTS_INTERNAL_GATE_ENV, '')
    expect(() => handler('runtimeEnvironments:remove')(null, { selector: 'wsl:ubuntu' })).toThrow(
      WSL_HOSTS_GATED_OFF_MESSAGE
    )
    expect(mocks.wsl.service!.remove).not.toHaveBeenCalled()
    expect(mocks.removeEnvironment).not.toHaveBeenCalled()
  })

  it('refuses the default host before the gate check', () => {
    mocks.handle.mockClear()
    register('wsl:ubuntu')
    useHost('wsl')
    vi.stubEnv(WSL_HOSTS_INTERNAL_GATE_ENV, '')
    expect(() => handler('runtimeEnvironments:remove')(null, { selector: 'wsl:ubuntu' })).toThrow(
      'This server is the default host for new projects. Choose another one under New projects open on before removing it.'
    )
  })

  it.each(NETWORK_HOSTS)('removes a %s host generically and synchronously', (name) => {
    useHost(name)
    const id = HOSTS[name].id
    expect(handler('runtimeEnvironments:remove')(null, { selector: id })).toEqual({
      removed: redacted(name)
    })
    expect(mocks.wsl.service!.remove).not.toHaveBeenCalled()
    expect(mocks.removeEnvironment).toHaveBeenCalledWith('/u', id)
    expect(mocks.retire).toHaveBeenCalledWith(id, expect.any(Function), expect.anything())
    // Removed by its own id, so no legacy-selector transport is closed.
    expect(mocks.closeRequest).not.toHaveBeenCalled()
  })
})
