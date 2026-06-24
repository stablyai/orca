/* eslint-disable max-lines -- Why: relay session tests need one shared mocked
provider/multiplexer harness to cover establish, reconnect, detach, and dispose
state transitions without duplicating brittle setup. */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SshRelaySession } from './ssh-relay-session'
import type { SshConnection } from './ssh-connection'
import type { Store } from '../persistence'
import type { SshPortForwardManager } from './ssh-port-forward'
import { AGENT_HOOK_INSTALL_PLUGINS_METHOD } from '../../shared/agent-hook-relay'
import { SSH_RELAY_CONFIGURE_GRACE_TIME_METHOD } from '../../shared/ssh-types'

const { muxRequestMock, installRemoteManagedAgentHooksMock, getMainWindowByIdMock } = vi.hoisted(
  () => ({
    muxRequestMock: vi.fn(),
    installRemoteManagedAgentHooksMock: vi.fn(),
    getMainWindowByIdMock: vi.fn()
  })
)

vi.mock('./ssh-relay-deploy', () => ({
  deployAndLaunchRelay: vi.fn()
}))

vi.mock('./ssh-relay-deploy-helpers', () => ({
  execCommand: vi.fn().mockResolvedValue('')
}))

vi.mock('./ssh-channel-multiplexer', () => {
  return {
    SshChannelMultiplexer: class MockSshChannelMultiplexer {
      notify = vi.fn()
      request = muxRequestMock
      onNotification = vi.fn().mockReturnValue(() => {})
      onRequest = vi.fn().mockReturnValue(() => {})
      onDispose = vi.fn().mockReturnValue(() => {})
      dispose = vi.fn()
      isDisposed = vi.fn().mockReturnValue(false)
    }
  }
})

vi.mock('../agent-hooks/remote-managed-hook-installers', () => ({
  installRemoteManagedAgentHooks: installRemoteManagedAgentHooksMock
}))

vi.mock('../providers/ssh-pty-provider', () => ({
  isSshPtyNotFoundError: (err: unknown) =>
    (err instanceof Error ? err.message : String(err)).includes('not found'),
  SshPtyProvider: class MockSshPtyProvider {
    onData = vi.fn().mockReturnValue(() => {})
    onReplay = vi.fn().mockReturnValue(() => {})
    onExit = vi.fn().mockReturnValue(() => {})
    attach = vi.fn().mockResolvedValue(undefined)
    attachForReconnect = vi.fn().mockResolvedValue({})
    dispose = vi.fn()
  }
}))

vi.mock('../providers/ssh-filesystem-provider', () => ({
  SshFilesystemProvider: class MockSshFilesystemProvider {
    dispose = vi.fn()
  }
}))

vi.mock('../providers/ssh-git-provider', () => ({
  SshGitProvider: class MockSshGitProvider {}
}))

vi.mock('../ipc/pty', () => ({
  registerSshPtyProvider: vi.fn(),
  unregisterSshPtyProvider: vi.fn(),
  getSshPtyProvider: vi.fn().mockReturnValue({
    dispose: vi.fn(),
    attach: vi.fn().mockResolvedValue(undefined),
    attachForReconnect: vi.fn().mockResolvedValue({})
  }),
  getPtyIdsForConnection: vi.fn().mockReturnValue([]),
  clearPtyOwnershipForConnection: vi.fn(),
  clearProviderPtyState: vi.fn(),
  deletePtyOwnership: vi.fn(),
  setPtyOwnership: vi.fn()
}))

vi.mock('../providers/ssh-filesystem-dispatch', () => ({
  registerSshFilesystemProvider: vi.fn(),
  unregisterSshFilesystemProvider: vi.fn(),
  getSshFilesystemProvider: vi.fn().mockReturnValue({ dispose: vi.fn() })
}))

vi.mock('../providers/ssh-git-dispatch', () => ({
  registerSshGitProvider: vi.fn(),
  unregisterSshGitProvider: vi.fn()
}))

vi.mock('../window/main-window-registry', () => ({
  broadcastToMainWindows: vi.fn(),
  getMainWindowById: getMainWindowByIdMock,
  sendToWindow: (
    window: { webContents: { send: (channel: string, ...args: unknown[]) => void } },
    channel: string,
    ...args: unknown[]
  ) => window.webContents.send(channel, ...args)
}))

const { deployAndLaunchRelay } = await import('./ssh-relay-deploy')
const { execCommand } = await import('./ssh-relay-deploy-helpers')
const { getRemoteHostPlatform } = await import('./ssh-remote-platform')
const {
  registerSshPtyProvider,
  unregisterSshPtyProvider,
  getPtyIdsForConnection,
  clearProviderPtyState,
  deletePtyOwnership,
  setPtyOwnership
} = await import('../ipc/pty')
const { registerSshFilesystemProvider, unregisterSshFilesystemProvider } =
  await import('../providers/ssh-filesystem-dispatch')
const { registerSshGitProvider, unregisterSshGitProvider } =
  await import('../providers/ssh-git-dispatch')

function createMockDeps() {
  const mockConn = {} as SshConnection
  const mockStore = {
    getRepos: vi.fn().mockReturnValue([]),
    getSshRemotePtyLeases: vi.fn().mockReturnValue([]),
    markSshRemotePtyLease: vi.fn(),
    markSshRemotePtyLeases: vi.fn()
  } as unknown as Store
  const mockPortForward = {
    removeAllForwards: vi.fn()
  } as unknown as SshPortForwardManager
  const mockWindow = {
    isDestroyed: () => false,
    webContents: { send: vi.fn() }
  }
  const windowId = 1
  const getMainWindow = vi.fn().mockReturnValue(mockWindow)
  getMainWindowByIdMock.mockImplementation((id: number) => (id === windowId ? mockWindow : null))
  return { mockConn, mockStore, mockPortForward, getMainWindow, mockWindow, windowId }
}

function mockDeploySuccess() {
  const mockTransport = {
    write: vi.fn(),
    onData: vi.fn(),
    onClose: vi.fn()
  }
  vi.mocked(deployAndLaunchRelay).mockResolvedValue({
    transport: mockTransport,
    platform: 'linux-x64'
  })
}

describe('SshRelaySession', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getMainWindowByIdMock.mockReset()
    delete process.env.ORCA_FEATURE_REMOTE_AGENT_HOOKS
    muxRequestMock.mockReset()
    muxRequestMock.mockResolvedValue([])
    installRemoteManagedAgentHooksMock.mockReset()
    installRemoteManagedAgentHooksMock.mockResolvedValue([])
    mockDeploySuccess()
    vi.mocked(getPtyIdsForConnection).mockReturnValue([])
  })

  it('starts in idle state', () => {
    const { mockStore, mockPortForward, getMainWindow } = createMockDeps()
    const session = new SshRelaySession('target-1', getMainWindow, mockStore, mockPortForward)
    expect(session.getState()).toBe('idle')
    expect(session.getMux()).toBeNull()
  })

  it('transitions idle → deploying → ready on establish', async () => {
    const { mockConn, mockStore, mockPortForward, getMainWindow } = createMockDeps()
    const session = new SshRelaySession('target-1', getMainWindow, mockStore, mockPortForward)

    await session.establish(mockConn)

    expect(session.getState()).toBe('ready')
    expect(session.getMux()).not.toBeNull()
    expect(registerSshPtyProvider).toHaveBeenCalledWith('target-1', expect.anything())
    expect(registerSshFilesystemProvider).toHaveBeenCalledWith('target-1', expect.anything())
    expect(registerSshGitProvider).toHaveBeenCalledWith('target-1', expect.anything())
  })

  it('installs remote managed hooks and relay-owned plugin assets before registering the SSH PTY provider', async () => {
    process.env.ORCA_FEATURE_REMOTE_AGENT_HOOKS = '1'
    muxRequestMock.mockImplementation(async (method: string) => {
      if (method === 'session.resolveHome') {
        return { resolvedPath: '/home/orca' }
      }
      return { ok: true }
    })
    const sftp = { end: vi.fn() }
    const { mockStore, mockPortForward, getMainWindow } = createMockDeps()
    const mockConn = {
      sftp: vi.fn().mockResolvedValue(sftp)
    } as unknown as SshConnection
    const session = new SshRelaySession('target-1', getMainWindow, mockStore, mockPortForward)

    await session.establish(mockConn)

    const installPluginsCallIndex = muxRequestMock.mock.calls.findIndex(
      ([method]) => method === AGENT_HOOK_INSTALL_PLUGINS_METHOD
    )
    expect(installPluginsCallIndex).toBeGreaterThanOrEqual(0)
    const installPluginsParams = muxRequestMock.mock.calls[installPluginsCallIndex]?.[1]
    expect(installPluginsParams).toMatchObject({
      piExtensionSource: expect.stringContaining('/hook/pi'),
      ompExtensionSource: expect.stringContaining('/hook/omp')
    })
    expect(mockConn.sftp).toHaveBeenCalledTimes(1)
    expect(installRemoteManagedAgentHooksMock).toHaveBeenCalledWith(sftp, '/home/orca')
    expect(sftp.end).toHaveBeenCalledTimes(1)
    expect(installRemoteManagedAgentHooksMock.mock.invocationCallOrder[0]).toBeLessThan(
      muxRequestMock.mock.invocationCallOrder[installPluginsCallIndex]
    )
    expect(muxRequestMock.mock.invocationCallOrder[installPluginsCallIndex]).toBeLessThan(
      vi.mocked(registerSshPtyProvider).mock.invocationCallOrder[0]
    )
  })

  it('does not run POSIX managed hook installers on Windows remotes', async () => {
    process.env.ORCA_FEATURE_REMOTE_AGENT_HOOKS = '1'
    const { mockStore, mockPortForward, getMainWindow } = createMockDeps()
    const mockConn = {
      writeFile: vi.fn().mockResolvedValue(undefined)
    } as unknown as SshConnection
    vi.mocked(deployAndLaunchRelay).mockResolvedValueOnce({
      transport: {
        write: vi.fn(),
        onData: vi.fn(),
        onClose: vi.fn()
      },
      platform: 'win32-x64',
      hostPlatform: getRemoteHostPlatform('win32-x64'),
      remoteHome: 'C:/Users/me',
      remoteRelayDir: 'C:/Users/me/.orca-remote/relay-v1',
      nodePath: 'C:/Program Files/nodejs/node.exe',
      sockPath: '\\\\.\\pipe\\orca-relay-123'
    })
    const session = new SshRelaySession('target-1', getMainWindow, mockStore, mockPortForward)

    await session.establish(mockConn)

    expect(installRemoteManagedAgentHooksMock).not.toHaveBeenCalled()
    expect(
      muxRequestMock.mock.calls.some(([method]) => method === AGENT_HOOK_INSTALL_PLUGINS_METHOD)
    ).toBe(true)
  })

  it('does not register providers if dispose wins during initial plugin sync', async () => {
    process.env.ORCA_FEATURE_REMOTE_AGENT_HOOKS = '1'
    let resolvePluginInstall!: () => void
    muxRequestMock.mockImplementation(async (method: string) => {
      if (method === AGENT_HOOK_INSTALL_PLUGINS_METHOD) {
        return new Promise((resolve) => {
          resolvePluginInstall = () => resolve({ ok: true })
        })
      }
      return { ok: true }
    })
    const { mockStore, mockPortForward, getMainWindow } = createMockDeps()
    const mockConn = {} as SshConnection
    const session = new SshRelaySession('target-1', getMainWindow, mockStore, mockPortForward)

    const establish = session.establish(mockConn)
    await vi.waitFor(() =>
      expect(muxRequestMock).toHaveBeenCalledWith(
        AGENT_HOOK_INSTALL_PLUGINS_METHOD,
        expect.anything()
      )
    )
    session.dispose()
    resolvePluginInstall()

    await expect(establish).rejects.toThrow('Session disposed during establish')
    expect(registerSshPtyProvider).not.toHaveBeenCalled()
    expect(registerSshFilesystemProvider).not.toHaveBeenCalled()
    expect(registerSshGitProvider).not.toHaveBeenCalled()
  })

  it('rejects establish when not idle', async () => {
    const { mockConn, mockStore, mockPortForward, getMainWindow } = createMockDeps()
    const session = new SshRelaySession('target-1', getMainWindow, mockStore, mockPortForward)

    await session.establish(mockConn)
    await expect(session.establish(mockConn)).rejects.toThrow('Cannot establish relay session')
  })

  it('reverts to idle on establish failure', async () => {
    const { mockConn, mockStore, mockPortForward, getMainWindow } = createMockDeps()
    vi.mocked(deployAndLaunchRelay).mockRejectedValueOnce(new Error('deploy failed'))

    const session = new SshRelaySession('target-1', getMainWindow, mockStore, mockPortForward)

    await expect(session.establish(mockConn)).rejects.toThrow('deploy failed')
    expect(session.getState()).toBe('idle')
  })

  it('reconnect tears down old providers and registers new ones', async () => {
    const { mockConn, mockStore, mockPortForward, getMainWindow } = createMockDeps()
    const session = new SshRelaySession('target-1', getMainWindow, mockStore, mockPortForward)

    await session.establish(mockConn)
    const oldMux = session.getMux()

    vi.clearAllMocks()
    mockDeploySuccess()

    await session.reconnect(mockConn)

    expect(session.getState()).toBe('ready')
    expect(session.getMux()).not.toBe(oldMux)
    expect(unregisterSshPtyProvider).toHaveBeenCalledWith('target-1')
    expect(unregisterSshFilesystemProvider).toHaveBeenCalledWith('target-1')
    expect(unregisterSshGitProvider).toHaveBeenCalledWith('target-1')
    expect(registerSshPtyProvider).toHaveBeenCalledWith('target-1', expect.anything())
  })

  it('installs a native Windows Orca CLI bridge without POSIX shell commands', async () => {
    const { mockStore, mockPortForward, getMainWindow } = createMockDeps()
    const mockConn = {
      writeFile: vi.fn().mockResolvedValue(undefined)
    } as unknown as SshConnection
    vi.mocked(deployAndLaunchRelay).mockResolvedValueOnce({
      transport: {
        write: vi.fn(),
        onData: vi.fn(),
        onClose: vi.fn()
      },
      platform: 'win32-x64',
      hostPlatform: getRemoteHostPlatform('win32-x64'),
      remoteHome: 'C:/Users/me',
      remoteRelayDir: 'C:/Users/me/.orca-remote/relay-v1',
      nodePath: 'C:/Program Files/nodejs/node.exe',
      sockPath: '\\\\.\\pipe\\orca-relay-123'
    })

    const session = new SshRelaySession('target-1', getMainWindow, mockStore, mockPortForward)

    await session.establish(mockConn)

    expect(execCommand).toHaveBeenCalledTimes(1)
    expect(vi.mocked(execCommand).mock.calls[0]?.[1]).toContain('powershell.exe')
    expect(vi.mocked(execCommand).mock.calls[0]?.[2]).toEqual({ wrapCommand: false })
    expect(mockConn.writeFile).toHaveBeenCalledWith(
      'C:/Users/me/.orca-relay/bin/orca.cmd',
      expect.stringContaining('@echo off'),
      { hostPlatform: getRemoteHostPlatform('win32-x64') }
    )
    const shim = vi.mocked(mockConn.writeFile).mock.calls[0]?.[1] as string
    expect(shim).toContain('C:/Users/me/.orca-remote/relay-v1')
    expect(shim).toContain('\\\\.\\pipe\\orca-relay-123')
    expect(shim).not.toContain('if not exist "%ORCA_RELAY_SOCKET_PATH%"')
    expect(shim).not.toContain('Orca SSH CLI bridge cannot find the relay socket')
    expect(shim).not.toContain('#!/usr/bin/env sh')
    expect(vi.mocked(execCommand).mock.calls.some(([, command]) => command.includes('chmod'))).toBe(
      false
    )
  })

  it('reconnect re-attaches live PTYs', async () => {
    const { mockConn, mockStore, mockPortForward, getMainWindow } = createMockDeps()
    vi.mocked(getPtyIdsForConnection).mockReturnValue(['pty-1', 'pty-2'])

    const session = new SshRelaySession('target-1', getMainWindow, mockStore, mockPortForward)
    await session.establish(mockConn)
    vi.clearAllMocks()
    mockDeploySuccess()

    const { getSshPtyProvider } = await import('../ipc/pty')
    const mockAttach = vi.fn().mockResolvedValue(undefined)
    vi.mocked(getSshPtyProvider).mockReturnValue({
      attachForReconnect: mockAttach,
      dispose: vi.fn()
    } as unknown as ReturnType<typeof getSshPtyProvider>)
    vi.mocked(getPtyIdsForConnection).mockReturnValue(['pty-1', 'pty-2'])

    await session.reconnect(mockConn)

    expect(mockAttach).toHaveBeenCalledWith('pty-1')
    expect(mockAttach).toHaveBeenCalledWith('pty-2')
  })

  it('forwards reconnect replay after the attach attempt is still current', async () => {
    const { mockConn, mockStore, mockPortForward, getMainWindow, mockWindow } = createMockDeps()
    const session = new SshRelaySession('target-1', getMainWindow, mockStore, mockPortForward)
    await session.establish(mockConn)
    vi.clearAllMocks()
    mockDeploySuccess()

    const { getSshPtyProvider } = await import('../ipc/pty')
    const mockAttach = vi.fn().mockResolvedValue({ replay: 'restored-output' })
    vi.mocked(getSshPtyProvider).mockReturnValue({
      attachForReconnect: mockAttach,
      dispose: vi.fn()
    } as unknown as ReturnType<typeof getSshPtyProvider>)
    vi.mocked(getPtyIdsForConnection).mockReturnValue(['pty-1'])

    await session.reconnect(mockConn)

    expect(mockWindow.webContents.send).toHaveBeenCalledWith('pty:replay', {
      id: 'ssh:target-1@@pty-1',
      data: 'restored-output'
    })
  })

  it('retries reconnect replay until runtime ownership is available', async () => {
    vi.useFakeTimers()
    try {
      const { mockConn, mockStore, mockPortForward, getMainWindow, mockWindow } = createMockDeps()
      let ownerWindowId: number | null = null
      const runtime = {
        resolveOwnerWindowIdForPtyId: vi.fn(() => ownerWindowId),
        onPtyExit: vi.fn()
      }
      const session = new SshRelaySession(
        'target-1',
        getMainWindow,
        mockStore,
        mockPortForward,
        runtime as never
      )
      await session.establish(mockConn)
      vi.clearAllMocks()
      mockDeploySuccess()

      const { getSshPtyProvider } = await import('../ipc/pty')
      const mockAttach = vi.fn().mockResolvedValue({ replay: 'late-owned-output' })
      vi.mocked(getSshPtyProvider).mockReturnValue({
        attachForReconnect: mockAttach,
        dispose: vi.fn()
      } as unknown as ReturnType<typeof getSshPtyProvider>)
      vi.mocked(getPtyIdsForConnection).mockReturnValue(['pty-1'])

      await session.reconnect(mockConn)
      await vi.advanceTimersByTimeAsync(49)
      expect(mockWindow.webContents.send).not.toHaveBeenCalledWith('pty:replay', expect.anything())

      ownerWindowId = 1
      await vi.advanceTimersByTimeAsync(1)

      expect(mockWindow.webContents.send).toHaveBeenCalledWith('pty:replay', {
        id: 'ssh:target-1@@pty-1',
        data: 'late-owned-output'
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not fallback-broadcast PTY stream events when runtime ownership is unknown', async () => {
    const { mockConn, mockStore, mockPortForward, getMainWindow, mockWindow } = createMockDeps()
    const runtime = {
      resolveOwnerWindowIdForPtyId: vi.fn().mockReturnValue(null),
      onPtyData: vi.fn().mockReturnValue(42),
      onPtyExit: vi.fn()
    }
    const session = new SshRelaySession(
      'target-1',
      getMainWindow,
      mockStore,
      mockPortForward,
      runtime as never
    )
    await session.establish(mockConn)

    const ptyProvider = vi.mocked(registerSshPtyProvider).mock.calls[0]?.[1] as unknown as {
      onData: ReturnType<typeof vi.fn>
      onReplay: ReturnType<typeof vi.fn>
      onExit: ReturnType<typeof vi.fn>
    }
    const onData = ptyProvider.onData.mock.calls[0]?.[0]
    const onReplay = ptyProvider.onReplay.mock.calls[0]?.[0]
    const onExit = ptyProvider.onExit.mock.calls[0]?.[0]

    onData({ id: 'pty-unknown', data: 'hello' })
    onReplay({ id: 'pty-unknown', data: 'snapshot' })
    onExit({ id: 'pty-unknown', code: 0 })

    expect(getMainWindow).not.toHaveBeenCalled()
    expect(mockWindow.webContents.send).not.toHaveBeenCalledWith('pty:data', expect.anything())
    expect(mockWindow.webContents.send).not.toHaveBeenCalledWith('pty:replay', expect.anything())
    expect(mockWindow.webContents.send).not.toHaveBeenCalledWith('pty:exit', expect.anything())
    expect(runtime.onPtyData).toHaveBeenCalledWith('pty-unknown', 'hello', expect.any(Number))
    expect(runtime.onPtyExit).toHaveBeenCalledWith('pty-unknown', 0)
    expect(mockStore.markSshRemotePtyLease).toHaveBeenCalledWith(
      'target-1',
      'pty-unknown',
      'terminated'
    )
  })

  it('retries fresh PTY stream events until runtime ownership is available', async () => {
    vi.useFakeTimers()
    try {
      const { mockConn, mockStore, mockPortForward, getMainWindow, mockWindow } = createMockDeps()
      let ownerWindowId: number | null = null
      const runtime = {
        resolveOwnerWindowIdForPtyId: vi.fn(() => ownerWindowId),
        onPtyData: vi.fn().mockReturnValueOnce(7).mockReturnValueOnce(8),
        onPtyExit: vi.fn()
      }
      const session = new SshRelaySession(
        'target-1',
        getMainWindow,
        mockStore,
        mockPortForward,
        runtime as never
      )
      await session.establish(mockConn)

      const ptyProvider = vi.mocked(registerSshPtyProvider).mock.calls[0]?.[1] as unknown as {
        onData: ReturnType<typeof vi.fn>
      }
      const onData = ptyProvider.onData.mock.calls[0]?.[0]

      onData({ id: 'pty-late-owner', data: 'hello ' })
      onData({ id: 'pty-late-owner', data: 'world' })
      await vi.advanceTimersByTimeAsync(24)
      expect(mockWindow.webContents.send).not.toHaveBeenCalledWith('pty:data', expect.anything())

      ownerWindowId = 1
      await vi.advanceTimersByTimeAsync(1)

      expect(mockWindow.webContents.send).toHaveBeenCalledWith('pty:data', {
        id: 'pty-late-owner',
        data: 'hello ',
        seq: 7,
        rawLength: 6
      })
      expect(mockWindow.webContents.send).toHaveBeenCalledWith('pty:data', {
        id: 'pty-late-owner',
        data: 'world',
        seq: 8,
        rawLength: 5
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('preserves queued ownerless PTY stream data above the startup retry burst size', async () => {
    vi.useFakeTimers()
    try {
      const { mockConn, mockStore, mockPortForward, getMainWindow, mockWindow } = createMockDeps()
      let ownerWindowId: number | null = null
      let nextSeq = 0
      const runtime = {
        resolveOwnerWindowIdForPtyId: vi.fn(() => ownerWindowId),
        onPtyData: vi.fn((_id: string, data: string) => {
          nextSeq += data.length
          return nextSeq
        }),
        onPtyExit: vi.fn()
      }
      const session = new SshRelaySession(
        'target-1',
        getMainWindow,
        mockStore,
        mockPortForward,
        runtime as never
      )
      await session.establish(mockConn)

      const ptyProvider = vi.mocked(registerSshPtyProvider).mock.calls[0]?.[1] as unknown as {
        onData: ReturnType<typeof vi.fn>
      }
      const onData = ptyProvider.onData.mock.calls[0]?.[0]
      const chunks = ['a'.repeat(128 * 1024), 'b'.repeat(128 * 1024), 'c'.repeat(128 * 1024)]

      for (const data of chunks) {
        onData({ id: 'pty-late-owner-large', data })
      }
      await vi.advanceTimersByTimeAsync(24)
      expect(mockWindow.webContents.send).not.toHaveBeenCalledWith('pty:data', expect.anything())

      ownerWindowId = 1
      await vi.advanceTimersByTimeAsync(1)

      const sentData = mockWindow.webContents.send.mock.calls
        .filter(([channel]) => channel === 'pty:data')
        .map(([, payload]) => payload)
      expect(sentData).toEqual([
        {
          id: 'pty-late-owner-large',
          data: chunks[0],
          seq: 128 * 1024,
          rawLength: 128 * 1024
        },
        {
          id: 'pty-late-owner-large',
          data: chunks[1],
          seq: 256 * 1024,
          rawLength: 128 * 1024
        },
        {
          id: 'pty-late-owner-large',
          data: chunks[2],
          seq: 384 * 1024,
          rawLength: 128 * 1024
        }
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not deliver queued ownerless PTY stream data after dispose', async () => {
    vi.useFakeTimers()
    try {
      const { mockConn, mockStore, mockPortForward, getMainWindow, mockWindow } = createMockDeps()
      let ownerWindowId: number | null = null
      const runtime = {
        resolveOwnerWindowIdForPtyId: vi.fn(() => ownerWindowId),
        onPtyData: vi.fn().mockReturnValue(9),
        onPtyExit: vi.fn()
      }
      const session = new SshRelaySession(
        'target-1',
        getMainWindow,
        mockStore,
        mockPortForward,
        runtime as never
      )
      await session.establish(mockConn)

      const ptyProvider = vi.mocked(registerSshPtyProvider).mock.calls[0]?.[1] as unknown as {
        onData: ReturnType<typeof vi.fn>
      }
      const onData = ptyProvider.onData.mock.calls[0]?.[0]

      onData({ id: 'pty-late-owner', data: 'stale output' })
      session.dispose()
      ownerWindowId = 1
      await vi.advanceTimersByTimeAsync(50)

      expect(mockWindow.webContents.send).not.toHaveBeenCalledWith('pty:data', expect.anything())
    } finally {
      vi.useRealTimers()
    }
  })

  it('retries ownerless PTY stream data before exit when ownership appears late', async () => {
    vi.useFakeTimers()
    try {
      const { mockConn, mockStore, mockPortForward, getMainWindow, mockWindow } = createMockDeps()
      let ownerWindowId: number | null = null
      const runtime = {
        resolveOwnerWindowIdForPtyId: vi.fn(() => ownerWindowId),
        onPtyData: vi.fn().mockReturnValue(10),
        onPtyExit: vi.fn()
      }
      const session = new SshRelaySession(
        'target-1',
        getMainWindow,
        mockStore,
        mockPortForward,
        runtime as never
      )
      await session.establish(mockConn)

      const ptyProvider = vi.mocked(registerSshPtyProvider).mock.calls[0]?.[1] as unknown as {
        onData: ReturnType<typeof vi.fn>
        onExit: ReturnType<typeof vi.fn>
      }
      const onData = ptyProvider.onData.mock.calls[0]?.[0]
      const onExit = ptyProvider.onExit.mock.calls[0]?.[0]
      mockWindow.webContents.send.mockClear()

      onData({ id: 'pty-short-lived', data: 'startup output' })
      onExit({ id: 'pty-short-lived', code: 0 })
      await vi.advanceTimersByTimeAsync(24)
      expect(mockWindow.webContents.send).not.toHaveBeenCalledWith('pty:data', expect.anything())
      expect(mockWindow.webContents.send).not.toHaveBeenCalledWith('pty:exit', expect.anything())

      ownerWindowId = 1
      await vi.advanceTimersByTimeAsync(1)

      expect(mockWindow.webContents.send).toHaveBeenNthCalledWith(1, 'pty:data', {
        id: 'pty-short-lived',
        data: 'startup output',
        seq: 10,
        rawLength: 'startup output'.length
      })
      expect(mockWindow.webContents.send).toHaveBeenNthCalledWith(2, 'pty:exit', {
        id: 'pty-short-lived',
        code: 0
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('drops identical reconnect replay payloads inside one reconnect burst', async () => {
    const { mockConn, mockStore, mockPortForward, getMainWindow, mockWindow } = createMockDeps()
    const session = new SshRelaySession('target-1', getMainWindow, mockStore, mockPortForward)
    await session.establish(mockConn)
    vi.clearAllMocks()
    mockDeploySuccess()

    const { getSshPtyProvider } = await import('../ipc/pty')
    const mockAttach = vi.fn().mockResolvedValue({ replay: 'same-output' })
    vi.mocked(getSshPtyProvider).mockReturnValue({
      attachForReconnect: mockAttach,
      dispose: vi.fn()
    } as unknown as ReturnType<typeof getSshPtyProvider>)
    vi.mocked(getPtyIdsForConnection).mockReturnValue(['pty-1'])

    await session.reconnect(mockConn)
    await session.reconnect(mockConn)

    const replaySends = vi
      .mocked(mockWindow.webContents.send)
      .mock.calls.filter(([channel]) => channel === 'pty:replay')
    expect(mockAttach).toHaveBeenCalledTimes(2)
    expect(replaySends).toHaveLength(1)
  })

  it('does not deliver delayed reconnect replay after dispose', async () => {
    vi.useFakeTimers()
    try {
      const { mockConn, mockStore, mockPortForward, getMainWindow, mockWindow } = createMockDeps()
      let ownerWindowId: number | null = null
      const runtime = {
        resolveOwnerWindowIdForPtyId: vi.fn(() => ownerWindowId),
        onPtyExit: vi.fn()
      }
      const session = new SshRelaySession(
        'target-1',
        getMainWindow,
        mockStore,
        mockPortForward,
        runtime as never
      )
      await session.establish(mockConn)
      vi.clearAllMocks()
      mockDeploySuccess()

      const { getSshPtyProvider } = await import('../ipc/pty')
      const mockAttach = vi.fn().mockResolvedValue({ replay: 'stale-replay' })
      vi.mocked(getSshPtyProvider).mockReturnValue({
        attachForReconnect: mockAttach,
        dispose: vi.fn()
      } as unknown as ReturnType<typeof getSshPtyProvider>)
      vi.mocked(getPtyIdsForConnection).mockReturnValue(['pty-1'])

      await session.reconnect(mockConn)
      session.dispose()
      ownerWindowId = 1
      await vi.advanceTimersByTimeAsync(50)

      expect(mockWindow.webContents.send).not.toHaveBeenCalledWith('pty:replay', expect.anything())
    } finally {
      vi.useRealTimers()
    }
  })

  it('establish re-attaches owned PTYs after explicit disconnect', async () => {
    const { mockConn, mockStore, mockPortForward, getMainWindow } = createMockDeps()
    const { getSshPtyProvider } = await import('../ipc/pty')
    const mockAttach = vi.fn().mockResolvedValue(undefined)
    vi.mocked(getSshPtyProvider).mockReturnValue({
      attachForReconnect: mockAttach,
      dispose: vi.fn()
    } as unknown as ReturnType<typeof getSshPtyProvider>)
    vi.mocked(getPtyIdsForConnection).mockReturnValue(['ssh:target-1@@pty-1'])

    const session = new SshRelaySession('target-1', getMainWindow, mockStore, mockPortForward)

    await session.establish(mockConn)

    expect(mockAttach).toHaveBeenCalledWith('pty-1')
    expect(setPtyOwnership).toHaveBeenCalledWith('ssh:target-1@@pty-1', 'target-1')
    expect(mockStore.markSshRemotePtyLease).toHaveBeenCalledWith('target-1', 'pty-1', 'attached')
  })

  it('establish re-attaches durable leases after app restart', async () => {
    const { mockConn, mockStore, mockPortForward, getMainWindow } = createMockDeps()
    const { getSshPtyProvider } = await import('../ipc/pty')
    const mockAttach = vi.fn().mockResolvedValue(undefined)
    vi.mocked(getSshPtyProvider).mockReturnValue({
      attachForReconnect: mockAttach,
      dispose: vi.fn()
    } as unknown as ReturnType<typeof getSshPtyProvider>)
    vi.mocked(getPtyIdsForConnection).mockReturnValue([])
    vi.mocked(mockStore.getSshRemotePtyLeases).mockReturnValue([
      { targetId: 'target-1', ptyId: 'pty-live', state: 'detached' },
      { targetId: 'target-1', ptyId: 'pty-expired', state: 'expired' }
    ] as ReturnType<typeof mockStore.getSshRemotePtyLeases>)

    const session = new SshRelaySession('target-1', getMainWindow, mockStore, mockPortForward)

    await session.establish(mockConn)

    expect(mockAttach).toHaveBeenCalledWith('pty-live')
    expect(mockAttach).not.toHaveBeenCalledWith('pty-expired')
    expect(setPtyOwnership).toHaveBeenCalledWith('ssh:target-1@@pty-live', 'target-1')
    expect(mockStore.markSshRemotePtyLease).toHaveBeenCalledWith('target-1', 'pty-live', 'attached')
  })

  it('rejects establish if detach wins while reattach is in flight', async () => {
    const { mockConn, mockStore, mockPortForward, getMainWindow } = createMockDeps()
    const { getSshPtyProvider } = await import('../ipc/pty')
    let resolveAttach!: () => void
    const mockAttach = vi.fn().mockReturnValue(
      new Promise<void>((resolve) => {
        resolveAttach = resolve
      })
    )
    vi.mocked(getSshPtyProvider).mockReturnValue({
      attachForReconnect: mockAttach,
      dispose: vi.fn()
    } as unknown as ReturnType<typeof getSshPtyProvider>)
    vi.mocked(getPtyIdsForConnection).mockReturnValue(['pty-1'])

    const session = new SshRelaySession('target-1', getMainWindow, mockStore, mockPortForward)
    const establish = session.establish(mockConn)
    await vi.waitFor(() => expect(mockAttach).toHaveBeenCalledWith('pty-1'))
    session.detach()
    resolveAttach()

    await expect(establish).rejects.toThrow('Session disposed during establish')
    expect(setPtyOwnership).not.toHaveBeenCalledWith('pty-1', 'target-1')
    expect(mockStore.markSshRemotePtyLease).not.toHaveBeenCalledWith(
      'target-1',
      'pty-1',
      'attached'
    )
  })

  it('does not mark PTYs attached if detach wins while reattach is in flight', async () => {
    const { mockConn, mockStore, mockPortForward, getMainWindow } = createMockDeps()
    const session = new SshRelaySession('target-1', getMainWindow, mockStore, mockPortForward)
    await session.establish(mockConn)
    vi.clearAllMocks()
    mockDeploySuccess()

    const { getSshPtyProvider } = await import('../ipc/pty')
    let resolveAttach!: () => void
    const mockAttach = vi.fn().mockReturnValue(
      new Promise<void>((resolve) => {
        resolveAttach = resolve
      })
    )
    vi.mocked(getSshPtyProvider).mockReturnValue({
      attachForReconnect: mockAttach,
      dispose: vi.fn()
    } as unknown as ReturnType<typeof getSshPtyProvider>)
    vi.mocked(getPtyIdsForConnection).mockReturnValue(['pty-1'])

    const reconnect = session.reconnect(mockConn)
    await vi.waitFor(() => expect(mockAttach).toHaveBeenCalledWith('pty-1'))
    session.detach()
    resolveAttach()
    await reconnect

    expect(setPtyOwnership).not.toHaveBeenCalledWith('pty-1', 'target-1')
    expect(mockStore.markSshRemotePtyLease).not.toHaveBeenCalledWith(
      'target-1',
      'pty-1',
      'attached'
    )
  })

  it('invalidates and broadcasts remote PTYs that cannot reattach after relay reconnect', async () => {
    const { mockConn, mockStore, mockPortForward, getMainWindow, mockWindow } = createMockDeps()
    const session = new SshRelaySession('target-1', getMainWindow, mockStore, mockPortForward)
    await session.establish(mockConn)
    vi.clearAllMocks()
    mockDeploySuccess()

    const { getSshPtyProvider } = await import('../ipc/pty')
    const mockAttach = vi
      .fn()
      .mockRejectedValueOnce(new Error('PTY "pty-stale" not found'))
      .mockResolvedValueOnce(undefined)
    vi.mocked(getSshPtyProvider).mockReturnValue({
      attachForReconnect: mockAttach,
      dispose: vi.fn()
    } as unknown as ReturnType<typeof getSshPtyProvider>)
    vi.mocked(getPtyIdsForConnection).mockReturnValue(['pty-stale', 'pty-live'])

    await session.reconnect(mockConn)

    expect(mockAttach).toHaveBeenCalledWith('pty-stale')
    expect(mockAttach).toHaveBeenCalledWith('pty-live')
    expect(clearProviderPtyState).toHaveBeenCalledWith('ssh:target-1@@pty-stale')
    expect(deletePtyOwnership).toHaveBeenCalledWith('ssh:target-1@@pty-stale')
    expect(mockWindow.webContents.send).toHaveBeenCalledWith('pty:exit', {
      id: 'ssh:target-1@@pty-stale',
      code: -1
    })
  })

  it('retries stale reconnect PTY exits when ownership appears late', async () => {
    vi.useFakeTimers()
    try {
      const { mockConn, mockStore, mockPortForward, getMainWindow, mockWindow } = createMockDeps()
      let ownerWindowId: number | null = null
      const runtime = {
        resolveOwnerWindowIdForPtyId: vi.fn(() => ownerWindowId),
        onPtyExit: vi.fn()
      }
      const session = new SshRelaySession(
        'target-1',
        getMainWindow,
        mockStore,
        mockPortForward,
        runtime as never
      )
      await session.establish(mockConn)
      vi.clearAllMocks()
      mockDeploySuccess()

      const { getSshPtyProvider } = await import('../ipc/pty')
      const mockAttach = vi.fn().mockRejectedValue(new Error('PTY "pty-stale" not found'))
      vi.mocked(getSshPtyProvider).mockReturnValue({
        attachForReconnect: mockAttach,
        dispose: vi.fn()
      } as unknown as ReturnType<typeof getSshPtyProvider>)
      vi.mocked(getPtyIdsForConnection).mockReturnValue(['pty-stale'])

      await session.reconnect(mockConn)
      await vi.advanceTimersByTimeAsync(24)

      expect(clearProviderPtyState).toHaveBeenCalledWith('ssh:target-1@@pty-stale')
      expect(deletePtyOwnership).toHaveBeenCalledWith('ssh:target-1@@pty-stale')
      expect(mockStore.markSshRemotePtyLease).toHaveBeenCalledWith(
        'target-1',
        'pty-stale',
        'expired'
      )
      expect(runtime.onPtyExit).toHaveBeenCalledWith('ssh:target-1@@pty-stale', -1)
      expect(mockWindow.webContents.send).not.toHaveBeenCalledWith('pty:exit', expect.anything())

      ownerWindowId = 1
      await vi.advanceTimersByTimeAsync(1)

      expect(mockWindow.webContents.send).toHaveBeenCalledWith('pty:exit', {
        id: 'ssh:target-1@@pty-stale',
        code: -1
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('routes transient reattach failures through relay-lost retry handling', async () => {
    const { mockConn, mockStore, mockPortForward, getMainWindow } = createMockDeps()
    const session = new SshRelaySession('target-1', getMainWindow, mockStore, mockPortForward)
    const onRelayLost = vi.fn()
    session.setOnRelayLost(onRelayLost)
    await session.establish(mockConn)
    vi.clearAllMocks()
    mockDeploySuccess()

    const { getSshPtyProvider } = await import('../ipc/pty')
    const mockAttach = vi.fn().mockRejectedValue(new Error('Multiplexer disposed'))
    vi.mocked(getSshPtyProvider).mockReturnValue({
      attachForReconnect: mockAttach,
      dispose: vi.fn()
    } as unknown as ReturnType<typeof getSshPtyProvider>)
    vi.mocked(getPtyIdsForConnection).mockReturnValue(['pty-live'])

    await session.reconnect(mockConn)

    expect(mockAttach).toHaveBeenCalledWith('pty-live')
    expect(onRelayLost).toHaveBeenCalledWith('target-1')
    expect(mockStore.markSshRemotePtyLease).not.toHaveBeenCalledWith(
      'target-1',
      'pty-live',
      'expired'
    )
  })

  it('dispose transitions to disposed and unregisters providers', async () => {
    const { mockConn, mockStore, mockPortForward, getMainWindow } = createMockDeps()
    const session = new SshRelaySession('target-1', getMainWindow, mockStore, mockPortForward)
    await session.establish(mockConn)

    session.dispose()

    expect(session.getState()).toBe('disposed')
    expect(unregisterSshPtyProvider).toHaveBeenCalledWith('target-1')
    expect(unregisterSshFilesystemProvider).toHaveBeenCalledWith('target-1')
    expect(unregisterSshGitProvider).toHaveBeenCalledWith('target-1')
  })

  it('dispose is idempotent', async () => {
    const { mockConn, mockStore, mockPortForward, getMainWindow } = createMockDeps()
    const session = new SshRelaySession('target-1', getMainWindow, mockStore, mockPortForward)
    await session.establish(mockConn)

    session.dispose()
    session.dispose()

    expect(session.getState()).toBe('disposed')
  })

  it('reconnect on disposed session is a no-op', async () => {
    const { mockConn, mockStore, mockPortForward, getMainWindow } = createMockDeps()
    const session = new SshRelaySession('target-1', getMainWindow, mockStore, mockPortForward)
    await session.establish(mockConn)
    session.dispose()
    vi.clearAllMocks()

    await session.reconnect(mockConn)

    expect(deployAndLaunchRelay).not.toHaveBeenCalled()
  })

  it('overlapping reconnects cancel the stale one', async () => {
    const { mockConn, mockStore, mockPortForward, getMainWindow } = createMockDeps()
    const session = new SshRelaySession('target-1', getMainWindow, mockStore, mockPortForward)
    await session.establish(mockConn)

    // Why: make the first reconnect hang so the second one aborts it
    let resolveFirst!: () => void
    vi.mocked(deployAndLaunchRelay).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveFirst = () =>
          resolve({
            transport: { write: vi.fn(), onData: vi.fn(), onClose: vi.fn() },
            platform: 'linux-x64' as const
          })
      })
    )
    mockDeploySuccess()

    const firstReconnect = session.reconnect(mockConn)
    const secondReconnect = session.reconnect(mockConn)

    resolveFirst()
    await Promise.all([firstReconnect, secondReconnect])

    expect(session.getState()).toBe('ready')
  })

  it('passes grace time to deployAndLaunchRelay', async () => {
    const { mockConn, mockStore, mockPortForward, getMainWindow } = createMockDeps()
    const session = new SshRelaySession('target-1', getMainWindow, mockStore, mockPortForward)

    await session.establish(mockConn, 600)

    expect(deployAndLaunchRelay).toHaveBeenCalledWith(mockConn, undefined, 600, 'target-1')
  })

  it('restores the configured relay grace after establish', async () => {
    const { mockConn, mockStore, mockPortForward, getMainWindow } = createMockDeps()
    const session = new SshRelaySession('target-1', getMainWindow, mockStore, mockPortForward)

    await session.establish(mockConn, 600)

    expect(session.getMux()?.notify).toHaveBeenCalledWith(SSH_RELAY_CONFIGURE_GRACE_TIME_METHOD, {
      graceTimeSeconds: 600
    })
  })

  it('sets relay grace to unlimited before host sleep', async () => {
    const { mockConn, mockStore, mockPortForward, getMainWindow } = createMockDeps()
    const session = new SshRelaySession('target-1', getMainWindow, mockStore, mockPortForward)
    await session.establish(mockConn)
    vi.mocked(session.getMux()!.notify).mockClear()

    session.prepareForHostSleep()

    expect(session.getMux()?.notify).toHaveBeenCalledWith(SSH_RELAY_CONFIGURE_GRACE_TIME_METHOD, {
      graceTimeSeconds: 0
    })
  })

  it('cleans up port forwards on dispose', async () => {
    const { mockConn, mockStore, mockPortForward, getMainWindow } = createMockDeps()
    const session = new SshRelaySession('target-1', getMainWindow, mockStore, mockPortForward)
    await session.establish(mockConn)

    session.dispose()

    expect(mockPortForward.removeAllForwards).toHaveBeenCalledWith('target-1')
  })

  it('cleans up port forwards on reconnect', async () => {
    const { mockConn, mockStore, mockPortForward, getMainWindow } = createMockDeps()
    const session = new SshRelaySession('target-1', getMainWindow, mockStore, mockPortForward)
    await session.establish(mockConn)
    vi.clearAllMocks()
    mockDeploySuccess()

    await session.reconnect(mockConn)

    expect(mockPortForward.removeAllForwards).toHaveBeenCalledWith('target-1')
  })

  it('establish cleans up mux and providers on partial registration failure', async () => {
    const { mockConn, mockStore, mockPortForward, getMainWindow } = createMockDeps()
    // Why: simulate registerRelayRoots failing after mux is created but
    // before providers are fully registered.
    mockStore.getRepos = vi.fn().mockImplementation(() => {
      throw new Error('store error during root registration')
    })

    const session = new SshRelaySession('target-1', getMainWindow, mockStore, mockPortForward)

    await expect(session.establish(mockConn)).rejects.toThrow('store error')
    expect(session.getState()).toBe('idle')
    expect(session.getMux()).toBeNull()
    expect(unregisterSshPtyProvider).toHaveBeenCalledWith('target-1')
    expect(unregisterSshFilesystemProvider).toHaveBeenCalledWith('target-1')
    expect(unregisterSshGitProvider).toHaveBeenCalledWith('target-1')
  })

  it('reconnect on idle session is a no-op', async () => {
    const { mockConn, mockStore, mockPortForward, getMainWindow } = createMockDeps()
    const session = new SshRelaySession('target-1', getMainWindow, mockStore, mockPortForward)

    await session.reconnect(mockConn)

    expect(session.getState()).toBe('idle')
    expect(deployAndLaunchRelay).not.toHaveBeenCalled()
  })

  it('reconnect failure still allows retry from onStateChange', async () => {
    const { mockConn, mockStore, mockPortForward, getMainWindow } = createMockDeps()
    const session = new SshRelaySession('target-1', getMainWindow, mockStore, mockPortForward)
    await session.establish(mockConn)

    // Fail the first reconnect
    vi.mocked(deployAndLaunchRelay).mockRejectedValueOnce(new Error('deploy failed'))
    await session.reconnect(mockConn)
    expect(session.getState()).toBe('reconnecting')

    // Retry should work — reconnect accepts 'reconnecting' state
    mockDeploySuccess()
    await session.reconnect(mockConn)
    expect(session.getState()).toBe('ready')
  })
})
