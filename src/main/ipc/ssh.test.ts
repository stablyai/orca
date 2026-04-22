import { describe, expect, it, vi, beforeEach } from 'vitest'

const {
  handleMock,
  mockSshStore,
  mockConnectionManager,
  mockDeployAndLaunchRelay,
  mockMux,
  mockPtyProvider,
  mockFsProvider,
  mockGitProvider,
  mockPortForwardManager
} = vi.hoisted(() => ({
  handleMock: vi.fn(),
  mockSshStore: {
    listTargets: vi.fn().mockReturnValue([]),
    getTarget: vi.fn(),
    addTarget: vi.fn(),
    updateTarget: vi.fn(),
    removeTarget: vi.fn(),
    importFromSshConfig: vi.fn().mockReturnValue([])
  },
  mockConnectionManager: {
    connect: vi.fn(),
    disconnect: vi.fn(),
    getState: vi.fn(),
    disconnectAll: vi.fn()
  },
  mockDeployAndLaunchRelay: vi.fn(),
  mockMux: {
    dispose: vi.fn(),
    isDisposed: vi.fn().mockReturnValue(false),
    onNotification: vi.fn(),
    notify: vi.fn()
  },
  mockPtyProvider: {
    onData: vi.fn(),
    onExit: vi.fn(),
    onReplay: vi.fn()
  },
  mockFsProvider: {},
  mockGitProvider: {},
  mockPortForwardManager: {
    addForward: vi.fn(),
    removeForward: vi.fn(),
    listForwards: vi.fn().mockReturnValue([]),
    removeAllForwards: vi.fn(),
    dispose: vi.fn()
  }
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: handleMock,
    on: vi.fn(),
    once: vi.fn(),
    removeHandler: vi.fn(),
    removeAllListeners: vi.fn()
  }
}))

vi.mock('../ssh/ssh-connection-store', () => ({
  SshConnectionStore: class MockSshConnectionStore {
    constructor() {
      return mockSshStore
    }
  }
}))

vi.mock('../ssh/ssh-connection', () => ({
  SshConnectionManager: class MockSshConnectionManager {
    constructor() {
      return mockConnectionManager
    }
  }
}))

vi.mock('../ssh/ssh-relay-deploy', () => ({
  deployAndLaunchRelay: mockDeployAndLaunchRelay
}))

vi.mock('../ssh/ssh-channel-multiplexer', () => ({
  SshChannelMultiplexer: class MockSshChannelMultiplexer {
    constructor() {
      return mockMux
    }
  }
}))

vi.mock('../providers/ssh-pty-provider', () => ({
  SshPtyProvider: class MockSshPtyProvider {
    constructor() {
      return mockPtyProvider
    }
  }
}))

vi.mock('../providers/ssh-filesystem-provider', () => ({
  SshFilesystemProvider: class MockSshFilesystemProvider {
    constructor() {
      return mockFsProvider
    }
  }
}))

vi.mock('./pty', () => ({
  registerSshPtyProvider: vi.fn(),
  unregisterSshPtyProvider: vi.fn(),
  clearPtyOwnershipForConnection: vi.fn(),
  getSshPtyProvider: vi.fn(),
  getPtyIdsForConnection: vi.fn().mockReturnValue([])
}))

vi.mock('../providers/ssh-filesystem-dispatch', () => ({
  registerSshFilesystemProvider: vi.fn(),
  unregisterSshFilesystemProvider: vi.fn(),
  getSshFilesystemProvider: vi.fn()
}))

vi.mock('../providers/ssh-git-provider', () => ({
  SshGitProvider: class MockSshGitProvider {
    constructor() {
      return mockGitProvider
    }
  }
}))

vi.mock('../providers/ssh-git-dispatch', () => ({
  registerSshGitProvider: vi.fn(),
  unregisterSshGitProvider: vi.fn()
}))

vi.mock('../ssh/ssh-port-forward', () => ({
  SshPortForwardManager: class MockPortForwardManager {
    constructor() {
      return mockPortForwardManager
    }
  }
}))

import { registerSshHandlers } from './ssh'
import type { SshTarget } from '../../shared/ssh-types'

describe('SSH IPC handlers', () => {
  const handlers = new Map<string, (_event: unknown, args: unknown) => unknown>()
  const mockStore = { getRepos: () => [] } as never
  const mockWindow = {
    isDestroyed: () => false,
    webContents: { send: vi.fn() }
  }

  beforeEach(() => {
    handlers.clear()
    handleMock.mockReset()
    handleMock.mockImplementation((channel: string, handler: (...a: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    })

    mockSshStore.listTargets.mockReset().mockReturnValue([])
    mockSshStore.getTarget.mockReset()
    mockSshStore.addTarget.mockReset()
    mockSshStore.updateTarget.mockReset()
    mockSshStore.removeTarget.mockReset()
    mockSshStore.importFromSshConfig.mockReset().mockReturnValue([])

    mockConnectionManager.connect.mockReset()
    mockConnectionManager.disconnect.mockReset()
    mockConnectionManager.getState.mockReset()
    mockConnectionManager.disconnectAll.mockReset()

    mockDeployAndLaunchRelay.mockReset().mockResolvedValue({
      transport: { write: vi.fn(), onData: vi.fn(), onClose: vi.fn() },
      platform: 'linux-x64'
    })
    mockMux.dispose.mockReset()
    mockMux.isDisposed.mockReset().mockReturnValue(false)
    mockMux.onNotification.mockReset()
    mockPtyProvider.onData.mockReset()
    mockPtyProvider.onExit.mockReset()
    mockPtyProvider.onReplay.mockReset()

    registerSshHandlers(mockStore, () => mockWindow as never)
  })

  it('registers all expected IPC channels', () => {
    const channels = Array.from(handlers.keys())
    expect(channels).toContain('ssh:listTargets')
    expect(channels).toContain('ssh:addTarget')
    expect(channels).toContain('ssh:updateTarget')
    expect(channels).toContain('ssh:removeTarget')
    expect(channels).toContain('ssh:importConfig')
    expect(channels).toContain('ssh:connect')
    expect(channels).toContain('ssh:disconnect')
    expect(channels).toContain('ssh:getState')
    expect(channels).toContain('ssh:testConnection')
  })

  it('ssh:listTargets returns targets from store', async () => {
    const mockTargets: SshTarget[] = [
      { id: 'ssh-1', label: 'Server 1', host: 'srv1.com', port: 22, username: 'admin' }
    ]
    mockSshStore.listTargets.mockReturnValue(mockTargets)

    const result = await handlers.get('ssh:listTargets')!(null, {})
    expect(result).toEqual(mockTargets)
  })

  it('ssh:addTarget calls store.addTarget', async () => {
    const newTarget = {
      label: 'New Server',
      host: 'new.example.com',
      port: 22,
      username: 'deploy'
    }
    const withId = { ...newTarget, id: 'ssh-new' }
    mockSshStore.addTarget.mockReturnValue(withId)

    const result = await handlers.get('ssh:addTarget')!(null, { target: newTarget })
    expect(mockSshStore.addTarget).toHaveBeenCalledWith(newTarget)
    expect(result).toEqual(withId)
  })

  it('ssh:removeTarget calls store.removeTarget', async () => {
    await handlers.get('ssh:removeTarget')!(null, { id: 'ssh-1' })
    expect(mockSshStore.removeTarget).toHaveBeenCalledWith('ssh-1')
  })

  it('ssh:importConfig returns imported targets', async () => {
    const imported: SshTarget[] = [
      { id: 'ssh-imp', label: 'staging', host: 'staging.com', port: 22, username: '' }
    ]
    mockSshStore.importFromSshConfig.mockReturnValue(imported)

    const result = await handlers.get('ssh:importConfig')!(null, {})
    expect(result).toEqual(imported)
  })

  it('ssh:connect throws for unknown targetId', async () => {
    mockSshStore.getTarget.mockReturnValue(undefined)

    await expect(handlers.get('ssh:connect')!(null, { targetId: 'unknown' })).rejects.toThrow(
      'SSH target "unknown" not found'
    )
  })

  it('ssh:connect calls connection manager', async () => {
    const target: SshTarget = {
      id: 'ssh-1',
      label: 'Server',
      host: 'example.com',
      port: 22,
      username: 'deploy'
    }
    mockSshStore.getTarget.mockReturnValue(target)
    mockConnectionManager.connect.mockResolvedValue({})
    mockConnectionManager.getState.mockReturnValue({
      targetId: 'ssh-1',
      status: 'connected',
      error: null,
      reconnectAttempt: 0
    })

    await handlers.get('ssh:connect')!(null, { targetId: 'ssh-1' })

    expect(mockConnectionManager.connect).toHaveBeenCalledWith(target)
  })

  it('ssh:disconnect calls connection manager', async () => {
    mockConnectionManager.disconnect.mockResolvedValue(undefined)

    await handlers.get('ssh:disconnect')!(null, { targetId: 'ssh-1' })

    expect(mockConnectionManager.disconnect).toHaveBeenCalledWith('ssh-1')
  })

  it('ssh:getState returns connection state', async () => {
    const state = {
      targetId: 'ssh-1',
      status: 'connected',
      error: null,
      reconnectAttempt: 0
    }
    mockConnectionManager.getState.mockReturnValue(state)

    const result = await handlers.get('ssh:getState')!(null, { targetId: 'ssh-1' })
    expect(result).toEqual(state)
  })
})
