import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SshRelaySession } from './ssh-relay-session'
import type { SshConnection } from './ssh-connection'
import {
  AGENT_HOOK_INSTALL_MANAGED_HOOKS_METHOD,
  AGENT_HOOK_INSTALL_PLUGINS_METHOD
} from '../../shared/agent-hook-relay'
import { SSH_RELAY_CONFIGURE_GRACE_TIME_METHOD } from '../../shared/ssh-types'
import { createMockDeps, mockDeploySuccess } from './ssh-relay-session-test-fixtures'

const { acceptOutputDataMock, muxRequestMock, openConsumerSessionMock, pauseAdapterMock } =
  vi.hoisted(() => ({
    acceptOutputDataMock: vi.fn().mockResolvedValue(undefined),
    muxRequestMock: vi.fn(),
    openConsumerSessionMock: vi.fn(),
    pauseAdapterMock: vi.fn()
  }))

vi.mock('./ssh-relay-deploy', () => ({
  deployAndLaunchRelay: vi.fn()
}))

vi.mock('./ssh-pty-consumer-session', () => ({
  openSshPtyConsumerSession: openConsumerSessionMock
}))

vi.mock('../ipc/ssh-pty-output-intake-registry', () => ({
  acceptSshPtyOutputData: acceptOutputDataMock,
  acceptSshPtyOutputExit: vi.fn().mockResolvedValue(undefined),
  allocateSshPtyProviderGeneration: vi.fn(() => 41),
  beginSshPtyOutputGenerationMigration: vi.fn(() => ({
    byPty: new Map(),
    completion: Promise.resolve()
  })),
  closeSshPtyOutputGeneration: vi.fn(),
  getSshPtyAcceptedSourceCheckpoints: vi.fn(() => []),
  applySshPtySourceCancellationProof: vi.fn(() => true),
  applySshPtySourceRecoveryCancellationProof: vi.fn(() => true),
  installSshPtySourceAckPublisher: vi.fn(() => () => {}),
  installSshPtySourceCancellationPublisher: vi.fn(() => () => {})
}))

vi.mock('./ssh-relay-deploy-helpers', () => ({
  execCommand: vi.fn().mockResolvedValue('')
}))

vi.mock('./ssh-channel-multiplexer', () => {
  return {
    SshChannelMultiplexer: class MockSshChannelMultiplexer {
      notify = vi.fn()
      notifyWithSettlement = vi.fn()
      request = muxRequestMock
      onNotification = vi.fn().mockReturnValue(() => {})
      onNotificationByMethod = vi.fn().mockReturnValue(() => {})
      onRequest = vi.fn().mockReturnValue(() => {})
      onDispose = vi.fn().mockReturnValue(() => {})
      dispose = vi.fn()
      isDisposed = vi.fn().mockReturnValue(false)
    }
  }
})

vi.mock('../providers/ssh-pty-provider', () => ({
  isSshPtyNotFoundError: (err: unknown) =>
    (err instanceof Error ? err.message : String(err)).includes('not found'),
  isSshPtyIdentityMismatchError: (err: unknown) =>
    (err instanceof Error ? err.message : String(err)).includes('identity mismatch'),
  SshPtyProvider: class MockSshPtyProvider {
    onData = vi.fn().mockReturnValue(() => {})
    onReplay = vi.fn().mockReturnValue(() => {})
    onExit = vi.fn().mockReturnValue(() => {})
    attach = vi.fn().mockResolvedValue(undefined)
    attachForReconnect = vi.fn().mockResolvedValue({})
    setPtyDeliveryPauseAdapter = pauseAdapterMock
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
  setPtyOwnership: vi.fn(),
  restorePtyIncarnation: vi.fn(),
  isCurrentPtyExit: vi.fn(() => true)
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

describe('SshRelaySession', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    openConsumerSessionMock.mockImplementation(async (_mux, options) => ({
      mode: 'legacy-fallback',
      clientInstanceId: options.clientInstanceId,
      serverBuildId: 'test-relay-build'
    }))
    delete process.env.ORCA_FEATURE_REMOTE_AGENT_HOOKS
    muxRequestMock.mockReset()
    muxRequestMock.mockResolvedValue([])
    mockDeploySuccess()
    vi.mocked(getPtyIdsForConnection).mockReturnValue([])
  })

  it('hands each PTY data event exactly once to the bounded main intake', async () => {
    const { mockConn, mockStore, mockPortForward, getMainWindow, mockWindow } = createMockDeps()
    const runtime = { onPtyData: vi.fn(), onPtyExit: vi.fn() }
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
    const onData = ptyProvider.onData.mock.calls[0]?.[0] as (payload: {
      id: string
      data: string
      providerGeneration: number
      ptyIncarnation: string
    }) => void

    onData({
      id: 'ssh-pty-1',
      data: 'ssh output',
      providerGeneration: 41,
      ptyIncarnation: 'incarnation-1'
    })

    expect(acceptOutputDataMock).toHaveBeenCalledTimes(1)
    expect(acceptOutputDataMock).toHaveBeenCalledWith({
      id: 'ssh-pty-1',
      data: 'ssh output',
      providerGeneration: 41,
      ptyIncarnation: 'incarnation-1',
      rawLength: 'ssh output'.length,
      transformed: false
    })
    expect(runtime.onPtyData).not.toHaveBeenCalled()
    expect(mockWindow.webContents.send).not.toHaveBeenCalledWith('pty:data', expect.anything())
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

  it('continues provider registration when the relay managed-hook request fails', async () => {
    process.env.ORCA_FEATURE_REMOTE_AGENT_HOOKS = '1'
    muxRequestMock.mockImplementation(async (method: string) => {
      if (method === 'preflight.detectAgents') {
        return { agents: ['codex'] }
      }
      if (method === AGENT_HOOK_INSTALL_MANAGED_HOOKS_METHOD) {
        throw new Error('runtime unavailable')
      }
      return { ok: true }
    })
    const { mockStore, mockPortForward, getMainWindow } = createMockDeps()
    const session = new SshRelaySession('target-1', getMainWindow, mockStore, mockPortForward)

    await session.establish({} as SshConnection)
    await vi.waitFor(() =>
      expect(muxRequestMock).toHaveBeenCalledWith(
        AGENT_HOOK_INSTALL_MANAGED_HOOKS_METHOD,
        expect.anything()
      )
    )

    expect(registerSshPtyProvider).toHaveBeenCalledWith('target-1', expect.anything())
    expect(
      muxRequestMock.mock.calls.some(([method]) => method === AGENT_HOOK_INSTALL_PLUGINS_METHOD)
    ).toBe(true)
  })

  it('suppresses expected managed-hook teardown errors during disconnect', async () => {
    process.env.ORCA_FEATURE_REMOTE_AGENT_HOOKS = '1'
    muxRequestMock.mockImplementation(async (method: string) => {
      if (method === 'preflight.detectAgents') {
        return { agents: ['codex'] }
      }
      if (method === AGENT_HOOK_INSTALL_MANAGED_HOOKS_METHOD) {
        throw Object.assign(new Error('request disposed'), { code: 'DISPOSED' })
      }
      return { ok: true }
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { mockStore, mockPortForward, getMainWindow } = createMockDeps()
    const session = new SshRelaySession('target-1', getMainWindow, mockStore, mockPortForward)

    try {
      await session.establish({} as SshConnection)
      await vi.waitFor(() =>
        expect(muxRequestMock).toHaveBeenCalledWith(
          AGENT_HOOK_INSTALL_MANAGED_HOOKS_METHOD,
          expect.anything()
        )
      )

      expect(registerSshPtyProvider).toHaveBeenCalledWith('target-1', expect.anything())
      expect(warn.mock.calls.flat().join(' ')).not.toContain('relay managed hook install failed')
    } finally {
      warn.mockRestore()
    }
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

    expect(
      muxRequestMock.mock.calls.some(
        ([method]) => method === AGENT_HOOK_INSTALL_MANAGED_HOOKS_METHOD
      )
    ).toBe(false)
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

  it('compiles a native Windows Orca CLI bridge without a cmd.exe shim', async () => {
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

    expect(execCommand).toHaveBeenCalledTimes(2)
    expect(vi.mocked(execCommand).mock.calls[0]?.[1]).toContain('powershell.exe')
    expect(vi.mocked(execCommand).mock.calls[0]?.[2]).toEqual({ wrapCommand: false })
    expect(mockConn.writeFile).toHaveBeenCalledWith(
      'C:/Users/me/.orca-relay/bin/orca-launcher.cs',
      expect.stringContaining('ProcessStartInfo'),
      { hostPlatform: getRemoteHostPlatform('win32-x64') }
    )
    const launcherSource = vi.mocked(mockConn.writeFile).mock.calls[0]?.[1] as string
    expect(launcherSource).toContain('ORCA_RELAY_SOCKET_PATH')
    expect(launcherSource).not.toContain('cmd.exe')
    expect(launcherSource).not.toContain('%*')
    expect(vi.mocked(execCommand).mock.calls[1]?.[1]).toContain('powershell.exe')
    expect(vi.mocked(execCommand).mock.calls[1]?.[2]).toEqual({ wrapCommand: false })
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

  it('does not wall-clock dedupe identical replay payloads from distinct reconnects', async () => {
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
    expect(replaySends).toHaveLength(2)
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
    expect(mockStore.markSshRemotePtyLeasesAttachedAsync).toHaveBeenCalledWith('target-1', [
      'pty-1'
    ])
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
      { targetId: 'target-1', ptyId: 'pty-live-2', state: 'detached' },
      { targetId: 'target-1', ptyId: 'pty-expired', state: 'expired' }
    ] as ReturnType<typeof mockStore.getSshRemotePtyLeases>)

    const session = new SshRelaySession('target-1', getMainWindow, mockStore, mockPortForward)

    await session.establish(mockConn)

    expect(mockAttach).toHaveBeenCalledWith('pty-live')
    expect(mockAttach).toHaveBeenCalledWith('pty-live-2')
    expect(mockAttach).not.toHaveBeenCalledWith('pty-expired')
    expect(setPtyOwnership).toHaveBeenCalledWith('ssh:target-1@@pty-live', 'target-1')
    expect(mockStore.markSshRemotePtyLeasesAttachedAsync).toHaveBeenCalledOnce()
    expect(mockStore.markSshRemotePtyLeasesAttachedAsync).toHaveBeenCalledWith(
      'target-1',
      expect.arrayContaining(['pty-live', 'pty-live-2'])
    )
  })

  it('forwards a lease tab identity to reattach so a reset relay cannot cross-wire it', async () => {
    const { mockConn, mockStore, mockPortForward, getMainWindow } = createMockDeps()
    const { getSshPtyProvider } = await import('../ipc/pty')
    const mockAttach = vi.fn().mockResolvedValue(undefined)
    vi.mocked(getSshPtyProvider).mockReturnValue({
      attachForReconnect: mockAttach,
      dispose: vi.fn()
    } as unknown as ReturnType<typeof getSshPtyProvider>)
    vi.mocked(getPtyIdsForConnection).mockReturnValue([])
    vi.mocked(mockStore.getSshRemotePtyLeases).mockReturnValue([
      { targetId: 'target-1', ptyId: 'pty-1', state: 'detached', tabId: 'tab-a' }
    ] as ReturnType<typeof mockStore.getSshRemotePtyLeases>)

    const session = new SshRelaySession('target-1', getMainWindow, mockStore, mockPortForward)
    await session.establish(mockConn)

    expect(mockAttach).toHaveBeenCalledWith('pty-1', { tabId: 'tab-a' })
  })

  it('forwards a lease pane identity when leaf identity is available', async () => {
    const { mockConn, mockStore, mockPortForward, getMainWindow } = createMockDeps()
    const { getSshPtyProvider } = await import('../ipc/pty')
    const mockAttach = vi.fn().mockResolvedValue(undefined)
    vi.mocked(getSshPtyProvider).mockReturnValue({
      attachForReconnect: mockAttach,
      dispose: vi.fn()
    } as unknown as ReturnType<typeof getSshPtyProvider>)
    vi.mocked(getPtyIdsForConnection).mockReturnValue([])
    const leafId = '11111111-1111-4111-8111-111111111111'
    vi.mocked(mockStore.getSshRemotePtyLeases).mockReturnValue([
      { targetId: 'target-1', ptyId: 'pty-1', state: 'detached', tabId: 'tab-a', leafId }
    ] as ReturnType<typeof mockStore.getSshRemotePtyLeases>)

    const session = new SshRelaySession('target-1', getMainWindow, mockStore, mockPortForward)
    await session.establish(mockConn)

    expect(mockAttach).toHaveBeenCalledWith('pty-1', {
      paneKey: `tab-a:${leafId}`,
      tabId: 'tab-a'
    })
  })

  it('does not expire a live reused relay id when attach rejects identity mismatch', async () => {
    const { mockConn, mockStore, mockPortForward, getMainWindow, mockWindow } = createMockDeps()
    const session = new SshRelaySession('target-1', getMainWindow, mockStore, mockPortForward)
    await session.establish(mockConn)
    vi.clearAllMocks()
    mockDeploySuccess()

    const { getSshPtyProvider } = await import('../ipc/pty')
    const mockAttach = vi
      .fn()
      .mockRejectedValueOnce(new Error('PTY "pty-1" not found (identity mismatch)'))
    vi.mocked(getSshPtyProvider).mockReturnValue({
      attachForReconnect: mockAttach,
      dispose: vi.fn()
    } as unknown as ReturnType<typeof getSshPtyProvider>)
    vi.mocked(getPtyIdsForConnection).mockReturnValue([])
    const staleLeafId = '11111111-1111-4111-8111-111111111111'
    vi.mocked(mockStore.getSshRemotePtyLeases).mockReturnValue([
      {
        targetId: 'target-1',
        ptyId: 'pty-1',
        state: 'detached',
        tabId: 'tab-old',
        leafId: staleLeafId
      }
    ] as ReturnType<typeof mockStore.getSshRemotePtyLeases>)

    await session.reconnect(mockConn)

    expect(mockAttach).toHaveBeenCalledWith('pty-1', {
      paneKey: `tab-old:${staleLeafId}`,
      tabId: 'tab-old'
    })
    expect(clearProviderPtyState).not.toHaveBeenCalledWith('ssh:target-1@@pty-1')
    expect(deletePtyOwnership).not.toHaveBeenCalledWith('ssh:target-1@@pty-1')
    expect(mockStore.markSshRemotePtyLease).not.toHaveBeenCalledWith('target-1', 'pty-1', 'expired')
    expect(mockWindow.webContents.send).not.toHaveBeenCalledWith('pty:exit', {
      id: 'ssh:target-1@@pty-1',
      code: -1
    })
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
    expect(mockStore.markSshRemotePtyLeasesAttachedAsync).not.toHaveBeenCalled()
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
    expect(mockStore.markSshRemotePtyLeasesAttachedAsync).not.toHaveBeenCalled()
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

  it('retries transient reattach failure without tearing down provider registration', async () => {
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
    const random = vi.spyOn(Math, 'random').mockReturnValue(0)

    try {
      await session.reconnect(mockConn)
    } finally {
      random.mockRestore()
    }

    expect(mockAttach).toHaveBeenCalledTimes(2)
    expect(onRelayLost).not.toHaveBeenCalled()
    expect(session.getState()).toBe('ready')
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
