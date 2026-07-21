// Why: host-aware `agent hooks status` (#8711) — these tests pin the install
// report each relay session records for the host that actually runs agents.
// Split from ssh-relay-session.test.ts to respect the max-lines lint budget.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SshRelaySession } from './ssh-relay-session'
import type { SshConnection } from './ssh-connection'
import { createMockDeps, mockDeploySuccess } from './ssh-relay-session-test-fixtures'

const { muxRequestMock } = vi.hoisted(() => ({ muxRequestMock: vi.fn() }))

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

vi.mock('../providers/ssh-pty-provider', () => ({
  isSshPtyNotFoundError: () => false,
  isSshPtyIdentityMismatchError: () => false,
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
  getSshPtyProvider: vi.fn().mockReturnValue({ dispose: vi.fn() }),
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

const { execCommand } = await import('./ssh-relay-deploy-helpers')

describe('SshRelaySession agent hook install report', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.ORCA_FEATURE_REMOTE_AGENT_HOOKS = '1'
    muxRequestMock.mockReset()
    muxRequestMock.mockImplementation(async (method: string) =>
      method === 'session.resolveHome'
        ? { resolvedPath: '/home/orca' }
        : method === 'preflight.detectAgents'
          ? { agents: ['claude', 'codex'] }
          : { ok: true }
    )
    mockDeploySuccess()
    vi.mocked(execCommand).mockResolvedValue('')
  })

  it('records a host-aware install report with per-agent statuses', async () => {
    const statuses = [
      {
        agent: 'claude',
        state: 'installed',
        configPath: '/home/orca/.claude/settings.json',
        managedHooksPresent: true,
        detail: null
      },
      {
        agent: 'codex',
        state: 'error',
        configPath: '/home/orca/.codex/hooks.json',
        managedHooksPresent: false,
        detail: 'Could not parse remote Codex hooks.json'
      }
    ]
    muxRequestMock.mockImplementation(async (method: string) =>
      method === 'session.resolveHome'
        ? { resolvedPath: '/home/orca' }
        : method === 'preflight.detectAgents'
          ? { agents: ['claude', 'codex'] }
        : { home: '/home/orca', installers: statuses.length, errors: 1, statuses }
    )
    const { mockStore, mockPortForward, getMainWindow } = createMockDeps()
    const mockConn = {} as SshConnection
    const session = new SshRelaySession('target-1', getMainWindow, mockStore, mockPortForward)

    await session.establish(mockConn)

    expect(session.getAgentHookInstallReport()).toEqual({
      targetId: 'target-1',
      remoteHome: '/home/orca',
      state: 'partial',
      detail: '1 agent hook install(s) incomplete on the remote host',
      statuses
    })
  })

  it('records a fully-installed report when every agent install succeeds', async () => {
    const statuses = [
      {
        agent: 'codex',
        state: 'installed',
        configPath: '/home/orca/.codex/hooks.json',
        managedHooksPresent: true,
        detail: null
      }
    ]
    muxRequestMock.mockImplementation(async (method: string) =>
      method === 'session.resolveHome'
        ? { resolvedPath: '/home/orca' }
        : method === 'preflight.detectAgents'
          ? { agents: ['codex'] }
        : { home: '/home/orca', installers: statuses.length, errors: 0, statuses }
    )
    const { mockStore, mockPortForward, getMainWindow } = createMockDeps()
    const mockConn = {} as SshConnection
    const session = new SshRelaySession('target-1', getMainWindow, mockStore, mockPortForward)

    await session.establish(mockConn)

    expect(session.getAgentHookInstallReport()).toEqual({
      targetId: 'target-1',
      remoteHome: '/home/orca',
      state: 'installed',
      detail: null,
      statuses
    })
  })

  it('records an error report when the remote hook install throws', async () => {
    const { mockStore, mockPortForward, getMainWindow } = createMockDeps()
    muxRequestMock.mockImplementation(async (method: string) => {
      if (method === 'session.resolveHome') {
        return { resolvedPath: '/home/orca' }
      }
      if (method === 'preflight.detectAgents') {
        return { agents: ['codex'] }
      }
      throw new Error('remote installer unavailable')
    })
    const mockConn = {} as SshConnection
    const session = new SshRelaySession('target-1', getMainWindow, mockStore, mockPortForward)

    await session.establish(mockConn)

    expect(session.getAgentHookInstallReport()).toEqual({
      targetId: 'target-1',
      remoteHome: null,
      state: 'error',
      detail: 'remote installer unavailable',
      statuses: []
    })
  })

  it('records a skipped report on Windows remotes', async () => {
    const { deployAndLaunchRelay } = await import('./ssh-relay-deploy')
    const { getRemoteHostPlatform } = await import('./ssh-remote-platform')
    vi.mocked(deployAndLaunchRelay).mockResolvedValueOnce({
      transport: { write: vi.fn(), onData: vi.fn(), onClose: vi.fn() },
      platform: 'win32-x64',
      hostPlatform: getRemoteHostPlatform('win32-x64'),
      remoteHome: 'C:/Users/me',
      remoteRelayDir: 'C:/Users/me/.orca-remote/relay-v1',
      nodePath: 'C:/Program Files/nodejs/node.exe',
      sockPath: '\\\\.\\pipe\\orca-relay-123'
    } as never)
    const { mockStore, mockPortForward, getMainWindow } = createMockDeps()
    const mockConn = {
      writeFile: vi.fn().mockResolvedValue(undefined)
    } as unknown as SshConnection
    const session = new SshRelaySession('target-1', getMainWindow, mockStore, mockPortForward)

    await session.establish(mockConn)

    expect(muxRequestMock).not.toHaveBeenCalledWith(
      'agent_hook.installManagedHooks',
      expect.anything()
    )
    expect(session.getAgentHookInstallReport()).toMatchObject({
      state: 'skipped',
      detail: expect.stringContaining('Windows')
    })
  })

  it('records a skipped report when remote agent hooks are disabled', async () => {
    process.env.ORCA_FEATURE_REMOTE_AGENT_HOOKS = '0'
    const { mockStore, mockPortForward, getMainWindow } = createMockDeps()
    const mockConn = { sftp: vi.fn() } as unknown as SshConnection
    const session = new SshRelaySession('target-1', getMainWindow, mockStore, mockPortForward)

    await session.establish(mockConn)

    expect(muxRequestMock).not.toHaveBeenCalledWith(
      'agent_hook.installManagedHooks',
      expect.anything()
    )
    expect(session.getAgentHookInstallReport()).toMatchObject({
      targetId: 'target-1',
      state: 'skipped',
      statuses: []
    })
  })

  it('does not let an aborted reconnect replace a newer install report', async () => {
    const installed = (detail: string) => ({
      home: '/home/orca',
      installers: 1,
      errors: 0,
      statuses: [
        {
          agent: 'codex',
          state: 'installed',
          configPath: '/home/orca/.codex/hooks.json',
          managedHooksPresent: true,
          detail
        }
      ]
    })
    let installRequest = 0
    let resolveStale!: (value: ReturnType<typeof installed>) => void
    let markStaleStarted!: () => void
    const staleStarted = new Promise<void>((resolve) => {
      markStaleStarted = resolve
    })
    const staleResult = new Promise<ReturnType<typeof installed>>((resolve) => {
      resolveStale = resolve
    })
    muxRequestMock.mockImplementation(async (method: string) => {
      if (method === 'preflight.detectAgents') {
        return { agents: ['codex'] }
      }
      if (method !== 'agent_hook.installManagedHooks') {
        return { resolvedPath: '/home/orca' }
      }
      installRequest += 1
      if (installRequest === 1) {
        return installed('initial')
      }
      if (installRequest === 2) {
        markStaleStarted()
        return await staleResult
      }
      return installed('new reconnect')
    })
    const { mockStore, mockPortForward, getMainWindow } = createMockDeps()
    const mockConn = {} as SshConnection
    const session = new SshRelaySession('target-1', getMainWindow, mockStore, mockPortForward)
    await session.establish(mockConn)
    await vi.waitFor(() =>
      expect(session.getAgentHookInstallReport()?.statuses[0]?.detail).toBe('initial')
    )

    const staleReconnect = session.reconnect(mockConn)
    await staleStarted
    await session.reconnect(mockConn)
    resolveStale(installed('stale reconnect'))
    await staleReconnect

    expect(session.getAgentHookInstallReport()?.statuses[0]?.detail).toBe('new reconnect')
  })
})
