import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SshRelaySession } from './ssh-relay-session'
import { createMockDeps, mockDeploySuccess } from './ssh-relay-session-test-fixtures'

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
      request = vi.fn().mockResolvedValue([])
      onNotification = vi.fn().mockReturnValue(() => {})
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
    attachForReconnect: vi.fn().mockResolvedValue({}),
    listProcesses: vi.fn().mockResolvedValue([]),
    shutdown: vi.fn().mockResolvedValue(undefined)
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

const { getSshPtyProvider, getPtyIdsForConnection } = await import('../ipc/pty')

describe('SshRelaySession orphaned relay PTY reaping', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockDeploySuccess()
    vi.mocked(getPtyIdsForConnection).mockReturnValue([])
  })

  it('establish reaps orphaned pane-bound relay PTYs the app no longer tracks', async () => {
    const { mockConn, mockStore, mockPortForward, getMainWindow } = createMockDeps()
    const mockShutdown = vi.fn().mockResolvedValue(undefined)
    const staleStartedAtMs = Date.now() - 60_000
    vi.mocked(getSshPtyProvider).mockReturnValue({
      attachForReconnect: vi.fn().mockResolvedValue(undefined),
      listProcesses: vi.fn().mockResolvedValue([
        {
          id: 'ssh:target-1@@pty-1',
          cwd: '/home/me',
          title: 'shell',
          paneKey: 'tab-a:leaf-a',
          startedAtMs: staleStartedAtMs
        },
        {
          id: 'ssh:target-1@@pty-9',
          cwd: '/home/me',
          title: 'shell',
          paneKey: 'tab-b:leaf-b',
          startedAtMs: staleStartedAtMs
        }
      ]),
      shutdown: mockShutdown,
      dispose: vi.fn()
    } as unknown as ReturnType<typeof getSshPtyProvider>)
    vi.mocked(getPtyIdsForConnection).mockReturnValue(['ssh:target-1@@pty-1'])

    const session = new SshRelaySession('target-1', getMainWindow, mockStore, mockPortForward)
    await session.establish(mockConn)

    expect(mockShutdown).toHaveBeenCalledTimes(1)
    expect(mockShutdown).toHaveBeenCalledWith('ssh:target-1@@pty-9', {
      immediate: true,
      keepHistory: false
    })
    expect(mockStore.markSshRemotePtyLease).toHaveBeenCalledWith('target-1', 'pty-9', 'terminated')
  })

  it('spares bare shells, young spawns, missing start times, and leased PTYs', async () => {
    const { mockConn, mockStore, mockPortForward, getMainWindow } = createMockDeps()
    const mockShutdown = vi.fn().mockResolvedValue(undefined)
    const staleStartedAtMs = Date.now() - 60_000
    vi.mocked(getSshPtyProvider).mockReturnValue({
      attachForReconnect: vi.fn().mockResolvedValue(undefined),
      listProcesses: vi.fn().mockResolvedValue([
        // Bare relay shell (e.g. remote CLI): no paneKey, never reaped.
        {
          id: 'ssh:target-1@@pty-2',
          cwd: '/home/me',
          title: 'shell',
          startedAtMs: staleStartedAtMs
        },
        // In-flight spawn racing the sweep: too young to reap.
        {
          id: 'ssh:target-1@@pty-3',
          cwd: '/home/me',
          title: 'shell',
          paneKey: 'tab-a:leaf-a',
          startedAtMs: Date.now()
        },
        // Durable lease: known, reattached instead of reaped.
        {
          id: 'ssh:target-1@@pty-4',
          cwd: '/home/me',
          title: 'shell',
          paneKey: 'tab-b:leaf-b',
          startedAtMs: staleStartedAtMs
        },
        // Pre-startedAtMs relay entry: age unknown, never reaped.
        { id: 'ssh:target-1@@pty-5', cwd: '/home/me', title: 'shell', paneKey: 'tab-c:leaf-c' }
      ]),
      shutdown: mockShutdown,
      dispose: vi.fn()
    } as unknown as ReturnType<typeof getSshPtyProvider>)
    vi.mocked(mockStore.getSshRemotePtyLeases).mockReturnValue([
      { targetId: 'target-1', ptyId: 'pty-4', state: 'detached' }
    ] as ReturnType<typeof mockStore.getSshRemotePtyLeases>)

    const session = new SshRelaySession('target-1', getMainWindow, mockStore, mockPortForward)
    await session.establish(mockConn)

    expect(mockShutdown).not.toHaveBeenCalled()
    expect(mockStore.markSshRemotePtyLease).not.toHaveBeenCalledWith(
      'target-1',
      expect.anything(),
      'terminated'
    )
  })

  it('reconnect reaps orphaned pane-bound relay PTYs', async () => {
    const { mockConn, mockStore, mockPortForward, getMainWindow } = createMockDeps()
    const session = new SshRelaySession('target-1', getMainWindow, mockStore, mockPortForward)
    await session.establish(mockConn)
    vi.clearAllMocks()
    mockDeploySuccess()

    const mockShutdown = vi.fn().mockResolvedValue(undefined)
    vi.mocked(getSshPtyProvider).mockReturnValue({
      attachForReconnect: vi.fn().mockResolvedValue(undefined),
      listProcesses: vi.fn().mockResolvedValue([
        {
          id: 'ssh:target-1@@pty-7',
          cwd: '/home/me',
          title: 'shell',
          paneKey: 'tab-a:leaf-a',
          startedAtMs: Date.now() - 60_000
        }
      ]),
      shutdown: mockShutdown,
      dispose: vi.fn()
    } as unknown as ReturnType<typeof getSshPtyProvider>)
    vi.mocked(getPtyIdsForConnection).mockReturnValue([])

    await session.reconnect(mockConn)

    expect(mockShutdown).toHaveBeenCalledWith('ssh:target-1@@pty-7', {
      immediate: true,
      keepHistory: false
    })
  })

  it('sweep failures do not block the session from becoming ready', async () => {
    const { mockConn, mockStore, mockPortForward, getMainWindow } = createMockDeps()
    vi.mocked(getSshPtyProvider).mockReturnValue({
      attachForReconnect: vi.fn().mockResolvedValue(undefined),
      listProcesses: vi.fn().mockRejectedValue(new Error('relay timeout')),
      shutdown: vi.fn(),
      dispose: vi.fn()
    } as unknown as ReturnType<typeof getSshPtyProvider>)

    const session = new SshRelaySession('target-1', getMainWindow, mockStore, mockPortForward)

    await expect(session.establish(mockConn)).resolves.toBeUndefined()
    expect(session.getState()).toBe('ready')
  })
})
