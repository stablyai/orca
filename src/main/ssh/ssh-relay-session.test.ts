import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SshRelaySession } from './ssh-relay-session'
import type { SshConnection } from './ssh-connection'
import { AGENT_HOOK_INSTALL_PLUGINS_METHOD } from '../../shared/agent-hook-relay'
import { SSH_RELAY_CONFIGURE_GRACE_TIME_METHOD } from '../../shared/ssh-types'
import { createMockDeps, mockDeploySuccess } from './ssh-relay-session-test-fixtures'

const { muxRequestMock, installRemoteManagedAgentHooksMock } = vi.hoisted(() => ({
  muxRequestMock: vi.fn(),
  installRemoteManagedAgentHooksMock: vi.fn()
}))

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
  isSshPtyIdentityMismatchError: (err: unknown) =>
    (err instanceof Error ? err.message : String(err)).includes('identity mismatch'),
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
  setPtyOwnership: vi.fn(),
  answerStartupTerminalColorQueriesForPty: vi.fn((_id: string, data: string) => data)
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
// Why: the hidden-delivery gate module is intentionally real (pure state, no
// electron deps) so the SSH parity tests exercise the same gate main uses.
const { markHiddenRendererPty, setRendererPtyDeliveryInterest } =
  await import('../ipc/pty-hidden-delivery-gate')
const { _resetHiddenRendererPtyDeliveryGateForTest } =
  await import('../ipc/pty-hidden-delivery-gate')
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
    delete process.env.ORCA_FEATURE_REMOTE_AGENT_HOOKS
    muxRequestMock.mockReset()
    muxRequestMock.mockResolvedValue([])
    installRemoteManagedAgentHooksMock.mockReset()
    installRemoteManagedAgentHooksMock.mockResolvedValue([])
    mockDeploySuccess()
    vi.mocked(getPtyIdsForConnection).mockReturnValue([])
    _resetHiddenRendererPtyDeliveryGateForTest()
  })

  it('drops hidden-gated PTY data after runtime ingestion with one restore marker', async () => {
    const { mockConn, mockStore, mockPortForward, getMainWindow, mockWindow } = createMockDeps()
    const runtime = {
      onPtyData: vi.fn(() => 99),
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
    const onData = ptyProvider.onData.mock.calls[0]?.[0] as (payload: {
      id: string
      data: string
    }) => void

    markHiddenRendererPty('ssh-pty-1')
    onData({ id: 'ssh-pty-1', data: 'hidden ssh output' })

    // Runtime ingestion still ran; renderer delivery shrank to one marker.
    expect(runtime.onPtyData).toHaveBeenCalledWith(
      'ssh-pty-1',
      'hidden ssh output',
      expect.any(Number)
    )
    expect(mockWindow.webContents.send).toHaveBeenCalledTimes(1)
    // Why out-of-band: an in-band empty pty:data sentinel is ambiguous with
    // chunks fully consumed by renderer OSC-9999 stripping.
    expect(mockWindow.webContents.send).toHaveBeenCalledWith('pty:modelRestoreNeeded', {
      id: 'ssh-pty-1',
      reason: 'hidden-drop',
      markerSeq: 99
    })

    onData({ id: 'ssh-pty-1', data: 'more hidden ssh output' })
    expect(mockWindow.webContents.send).toHaveBeenCalledTimes(1)

    // Delivery interest (renderer sidecars) suppresses the gate — parity with
    // the local path in ipc/pty.ts.
    setRendererPtyDeliveryInterest('ssh-pty-1', true)
    onData({ id: 'ssh-pty-1', data: 'sidecar ssh bytes' })
    expect(mockWindow.webContents.send).toHaveBeenLastCalledWith('pty:data', {
      id: 'ssh-pty-1',
      data: 'sidecar ssh bytes',
      seq: 99,
      rawLength: 'sidecar ssh bytes'.length
    })

    // Non-hidden PTYs are unaffected.
    onData({ id: 'ssh-pty-2', data: 'visible ssh output' })
    expect(mockWindow.webContents.send).toHaveBeenLastCalledWith('pty:data', {
      id: 'ssh-pty-2',
      data: 'visible ssh output',
      seq: 99,
      rawLength: 'visible ssh output'.length
    })
  })

  it('keeps hidden SSH delivery when the gate kill switch is off', async () => {
    const { mockConn, mockStore, mockPortForward, getMainWindow, mockWindow } = createMockDeps()
    ;(mockStore as unknown as { getSettings: () => unknown }).getSettings = vi.fn(() => ({
      terminalHiddenDeliveryGate: false
    }))
    const session = new SshRelaySession('target-1', getMainWindow, mockStore, mockPortForward)
    await session.establish(mockConn)
    const ptyProvider = vi.mocked(registerSshPtyProvider).mock.calls[0]?.[1] as unknown as {
      onData: ReturnType<typeof vi.fn>
    }
    const onData = ptyProvider.onData.mock.calls[0]?.[0] as (payload: {
      id: string
      data: string
    }) => void

    markHiddenRendererPty('ssh-pty-1')
    onData({ id: 'ssh-pty-1', data: 'still delivered' })

    expect(mockWindow.webContents.send).toHaveBeenCalledWith('pty:data', {
      id: 'ssh-pty-1',
      data: 'still delivered'
    })
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

  it.each([
    ['/bin/bash', "'/bin/bash' -lc 'printenv GROK_HOME | head -c 4097'"],
    ['/usr/bin/fish', "'/usr/bin/fish' -lc 'printenv GROK_HOME | head -c 4097'"],
    ['/bin/tcsh', "'/bin/tcsh' -lc 'printenv GROK_HOME | head -c 4097'"],
    ['/bin/sh', "'/bin/sh' -c 'printenv GROK_HOME | head -c 4097'"]
  ])('uses a shell-independent GROK_HOME probe with login shell %s', async (shell, command) => {
    process.env.ORCA_FEATURE_REMOTE_AGENT_HOOKS = '1'
    muxRequestMock.mockImplementation(async (method: string) =>
      method === 'session.resolveHome' ? { resolvedPath: '/home/orca' } : { ok: true }
    )
    vi.mocked(execCommand).mockResolvedValueOnce(`${shell}\n`).mockResolvedValueOnce('/srv/grok\n')
    const sftp = { end: vi.fn() }
    const { mockStore, mockPortForward, getMainWindow } = createMockDeps()
    const mockConn = { sftp: vi.fn().mockResolvedValue(sftp) } as unknown as SshConnection
    const session = new SshRelaySession('target-1', getMainWindow, mockStore, mockPortForward)

    await session.establish(mockConn)

    expect(execCommand).toHaveBeenNthCalledWith(
      1,
      mockConn,
      "printenv SHELL || printf '/bin/sh\\n'",
      { timeoutMs: 8_000 }
    )
    expect(execCommand).toHaveBeenNthCalledWith(2, mockConn, command, {
      wrapCommand: false,
      timeoutMs: 8_000
    })
    expect(installRemoteManagedAgentHooksMock).toHaveBeenCalledWith(sftp, '/home/orca', {
      grokHomeDir: '/srv/grok'
    })
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
    vi.mocked(execCommand)
      .mockResolvedValueOnce('/bin/bash\n')
      .mockResolvedValueOnce('/srv/grok profile\n')
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
    expect(installRemoteManagedAgentHooksMock).toHaveBeenCalledWith(sftp, '/home/orca', {
      grokHomeDir: '/srv/grok profile'
    })
    expect(sftp.end).toHaveBeenCalledTimes(1)
    expect(installRemoteManagedAgentHooksMock.mock.invocationCallOrder[0]).toBeLessThan(
      muxRequestMock.mock.invocationCallOrder[installPluginsCallIndex]
    )
    expect(muxRequestMock.mock.invocationCallOrder[installPluginsCallIndex]).toBeLessThan(
      vi.mocked(registerSshPtyProvider).mock.invocationCallOrder[0]
    )
  })

  it('falls back to login-home Grok config when the remote env probe is invalid', async () => {
    process.env.ORCA_FEATURE_REMOTE_AGENT_HOOKS = '1'
    muxRequestMock.mockImplementation(async (method: string) =>
      method === 'session.resolveHome' ? { resolvedPath: '/home/orca' } : { ok: true }
    )
    vi.mocked(execCommand)
      .mockResolvedValueOnce('/bin/bash\n')
      .mockResolvedValueOnce('relative/grok-home\n')
    const sftp = { end: vi.fn() }
    const { mockStore, mockPortForward, getMainWindow } = createMockDeps()
    const mockConn = { sftp: vi.fn().mockResolvedValue(sftp) } as unknown as SshConnection
    const session = new SshRelaySession('target-1', getMainWindow, mockStore, mockPortForward)

    await session.establish(mockConn)

    expect(installRemoteManagedAgentHooksMock).toHaveBeenCalledWith(sftp, '/home/orca', {
      grokHomeDir: '/home/orca/.grok'
    })
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
