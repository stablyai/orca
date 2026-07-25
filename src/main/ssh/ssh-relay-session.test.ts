import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SshRelaySession } from './ssh-relay-session'
import type { SshConnection } from './ssh-connection'
import {
  AGENT_HOOK_INSTALL_MANAGED_HOOKS_METHOD,
  AGENT_HOOK_INSTALL_PLUGINS_METHOD
} from '../../shared/agent-hook-relay'
import { SSH_RELAY_CONFIGURE_GRACE_TIME_METHOD } from '../../shared/ssh-types'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { RelayPtyLostEntry } from '../../shared/pty-revive-protocol'
import type { WorkspaceSessionState } from '../../shared/types'
import { createMockDeps, mockDeploySuccess } from './ssh-relay-session-test-fixtures'

const { muxRequestMock, archiveLostTerminalWorkerMock } = vi.hoisted(() => ({
  muxRequestMock: vi.fn(),
  archiveLostTerminalWorkerMock: vi.fn()
}))

vi.mock('./ssh-relay-deploy', () => ({
  deployAndLaunchRelay: vi.fn()
}))

vi.mock('./ssh-relay-deploy-helpers', () => ({
  execCommand: vi.fn().mockResolvedValue('')
}))

vi.mock('../terminal-lost-worker-archive', () => ({
  archiveLostTerminalWorker: archiveLostTerminalWorkerMock
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
  restorePtyIncarnation: vi.fn(),
  isCurrentPtyExit: vi.fn(() => true)
}))

vi.mock('../ipc/pty-renderer-delivery-router', () => ({
  routeExternalPtyData: vi.fn(),
  routeExternalPtyReplay: vi.fn(),
  routeExternalPtyExit: vi.fn()
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
  getSshPtyProvider,
  getPtyIdsForConnection,
  clearProviderPtyState,
  deletePtyOwnership,
  setPtyOwnership
} = await import('../ipc/pty')
const { registerSshFilesystemProvider, unregisterSshFilesystemProvider } =
  await import('../providers/ssh-filesystem-dispatch')
const { registerSshGitProvider, unregisterSshGitProvider } =
  await import('../providers/ssh-git-dispatch')
const { routeExternalPtyData, routeExternalPtyReplay, routeExternalPtyExit } =
  await import('../ipc/pty-renderer-delivery-router')

const REVIVE_WORKTREE_ID = 'repo-1::/worktree'
const REVIVE_TAB_ID = 'tab-1'
const REVIVE_LEAF_ID = '11111111-1111-4111-8111-111111111111'
const REVIVE_PANE_KEY = `${REVIVE_TAB_ID}:${REVIVE_LEAF_ID}`
const RELAY_LOST_WORKER: RelayPtyLostEntry = {
  id: 'ssh:target-1@@pty-lost',
  kind: 'recognized-worker',
  reason: 'process-not-running',
  pid: 42,
  cols: 80,
  rows: 24,
  cwd: '/repo',
  worktreeId: REVIVE_WORKTREE_ID,
  tabId: REVIVE_TAB_ID,
  paneKey: REVIVE_PANE_KEY
}

function workspaceSessionForRelayLostWorker(workerHint = false): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: {
      [REVIVE_WORKTREE_ID]: [
        {
          id: REVIVE_TAB_ID,
          worktreeId: REVIVE_WORKTREE_ID,
          title: 'Worker',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 10,
          ptyId: RELAY_LOST_WORKER.id
        }
      ]
    },
    terminalLayoutsByTabId: {
      [REVIVE_TAB_ID]: {
        root: { type: 'leaf', leafId: REVIVE_LEAF_ID },
        activeLeafId: REVIVE_LEAF_ID,
        expandedLeafId: null
      }
    },
    terminalPtyIncarnationsByPaneKey: { [REVIVE_PANE_KEY]: 'incarnation-1' },
    terminalArchiveHintsByPaneKey: {
      [REVIVE_PANE_KEY]: workerHint ? { launchAgent: 'codex', startedAt: 10 } : { cwd: '/repo' }
    }
  }
}

function configureStagedPtyRevive(args: {
  serialize: ReturnType<typeof vi.fn>
  revive: ReturnType<typeof vi.fn>
  reattachPtyIds?: string[]
}): { attachForReconnect: ReturnType<typeof vi.fn> } {
  const attachForReconnect = vi.fn().mockResolvedValue({})
  vi.mocked(getSshPtyProvider)
    .mockReset()
    .mockReturnValueOnce({
      serialize: args.serialize,
      dispose: vi.fn()
    } as unknown as ReturnType<typeof getSshPtyProvider>)
    .mockReturnValue({
      revive: args.revive,
      attachForReconnect,
      dispose: vi.fn()
    } as unknown as ReturnType<typeof getSshPtyProvider>)
  vi.mocked(getPtyIdsForConnection).mockReturnValueOnce(['ssh:target-1@@pty-lost'])
  vi.mocked(getPtyIdsForConnection).mockReturnValue(args.reattachPtyIds ?? [])
  return { attachForReconnect }
}

function mockReconnectPtyProvider(attachForReconnect: ReturnType<typeof vi.fn>): void {
  vi.mocked(getSshPtyProvider).mockReturnValue({
    attachForReconnect,
    dispose: vi.fn()
  } as unknown as ReturnType<typeof getSshPtyProvider>)
}

async function establishRelaySession() {
  const deps = createMockDeps()
  const session = new SshRelaySession(
    'target-1',
    deps.getMainWindow,
    deps.mockStore,
    deps.mockPortForward
  )
  await session.establish(deps.mockConn)
  return { ...deps, session }
}

describe('SshRelaySession', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    delete process.env.ORCA_FEATURE_REMOTE_AGENT_HOOKS
    muxRequestMock.mockReset()
    muxRequestMock.mockResolvedValue([])
    archiveLostTerminalWorkerMock.mockReset()
    vi.mocked(getSshPtyProvider)
      .mockReset()
      .mockReturnValue({
        dispose: vi.fn(),
        attach: vi.fn().mockResolvedValue(undefined),
        attachForReconnect: vi.fn().mockResolvedValue({})
      } as unknown as ReturnType<typeof getSshPtyProvider>)
    mockDeploySuccess()
    vi.mocked(getPtyIdsForConnection).mockReturnValue([])
  })

  it('routes SSH PTY data and its captured producer credit through bounded delivery', async () => {
    const { mockConn, mockStore, mockPortForward, getMainWindow } = createMockDeps()
    const session = new SshRelaySession('target-1', getMainWindow, mockStore, mockPortForward)
    await session.establish(mockConn)
    const ptyProvider = vi.mocked(registerSshPtyProvider).mock.calls[0]?.[1] as unknown as {
      onData: ReturnType<typeof vi.fn>
    }
    const onData = ptyProvider.onData.mock.calls[0]?.[0] as (payload: {
      id: string
      data: string
      upstreamCredit?: { charCount: number; acknowledge(chars: number): void }
    }) => void
    const upstreamCredit = { charCount: 16, acknowledge: vi.fn() }

    onData({ id: 'ssh-pty-1', data: 'remote PTY bytes', upstreamCredit })

    expect(routeExternalPtyData).toHaveBeenCalledWith({
      id: 'ssh-pty-1',
      data: 'remote PTY bytes',
      upstreamCredit
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

  it('installs all managed hooks in one relay RPC before plugins and PTY registration', async () => {
    process.env.ORCA_FEATURE_REMOTE_AGENT_HOOKS = '1'
    muxRequestMock.mockResolvedValue({ installers: 14, errors: 0 })
    const { mockStore, mockPortForward, getMainWindow } = createMockDeps()
    const sftp = vi.fn()
    const mockConn = {
      sftp,
      getHostKeyFingerprint: vi.fn(() => 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')
    } as unknown as SshConnection
    const session = new SshRelaySession('target-1', getMainWindow, mockStore, mockPortForward)

    await session.establish(mockConn)

    const managedHookCalls = muxRequestMock.mock.calls.filter(
      ([method]) => method === AGENT_HOOK_INSTALL_MANAGED_HOOKS_METHOD
    )
    const managedHookCallIndex = muxRequestMock.mock.calls.findIndex(
      ([method]) => method === AGENT_HOOK_INSTALL_MANAGED_HOOKS_METHOD
    )
    const installPluginsCallIndex = muxRequestMock.mock.calls.findIndex(
      ([method]) => method === AGENT_HOOK_INSTALL_PLUGINS_METHOD
    )
    expect(managedHookCalls).toEqual([
      [
        AGENT_HOOK_INSTALL_MANAGED_HOOKS_METHOD,
        { hostKeyFingerprint: 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }
      ]
    ])
    expect(installPluginsCallIndex).toBeGreaterThanOrEqual(0)
    const installPluginsParams = muxRequestMock.mock.calls[installPluginsCallIndex]?.[1]
    expect(installPluginsParams).toMatchObject({
      piExtensionSource: expect.stringContaining('/hook/pi'),
      ompExtensionSource: expect.stringContaining('/hook/omp')
    })
    expect(sftp).not.toHaveBeenCalled()
    expect(managedHookCallIndex).toBeLessThan(installPluginsCallIndex)
    expect(muxRequestMock.mock.invocationCallOrder[installPluginsCallIndex]).toBeLessThan(
      vi.mocked(registerSshPtyProvider).mock.invocationCallOrder[0]
    )
  })

  it('continues provider registration when the relay managed-hook request fails', async () => {
    process.env.ORCA_FEATURE_REMOTE_AGENT_HOOKS = '1'
    muxRequestMock.mockImplementation(async (method: string) => {
      if (method === AGENT_HOOK_INSTALL_MANAGED_HOOKS_METHOD) {
        throw new Error('runtime unavailable')
      }
      return { ok: true }
    })
    const { mockStore, mockPortForward, getMainWindow } = createMockDeps()
    const session = new SshRelaySession('target-1', getMainWindow, mockStore, mockPortForward)

    await session.establish({} as SshConnection)

    expect(registerSshPtyProvider).toHaveBeenCalledWith('target-1', expect.anything())
    expect(
      muxRequestMock.mock.calls.some(([method]) => method === AGENT_HOOK_INSTALL_PLUGINS_METHOD)
    ).toBe(true)
  })

  it('suppresses expected managed-hook teardown errors during disconnect', async () => {
    process.env.ORCA_FEATURE_REMOTE_AGENT_HOOKS = '1'
    muxRequestMock.mockImplementation(async (method: string) => {
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

    const mockAttach = vi.fn().mockResolvedValue(undefined)
    mockReconnectPtyProvider(mockAttach)
    vi.mocked(getPtyIdsForConnection).mockReturnValue(['pty-1', 'pty-2'])

    await session.reconnect(mockConn)

    expect(mockAttach).toHaveBeenCalledWith('pty-1')
    expect(mockAttach).toHaveBeenCalledWith('pty-2')
  })

  it.each([
    'typed recognized',
    'typed unclassified worker hint',
    'typed unclassified',
    'legacy',
    'malformed typed',
    'serialize failure',
    'archive failure'
  ])('keeps staged PTY revive %s on its compatible recovery path', async (state) => {
    const { mockConn, mockStore, session } = await establishRelaySession()
    vi.clearAllMocks()
    mockDeploySuccess()
    const serialize = vi.fn().mockResolvedValue('staged-pty-state')
    const revive = vi.fn()
    const lost = state.startsWith('typed unclassified')
      ? { ...RELAY_LOST_WORKER, kind: 'unclassified' as const }
      : RELAY_LOST_WORKER
    if (state === 'serialize failure') {
      serialize.mockRejectedValue(new Error('old relay stopped before serialize reply'))
    } else if (state === 'malformed typed') {
      revive.mockRejectedValue(new Error('typed outcome validation failed'))
    } else if (state === 'legacy') {
      revive.mockResolvedValue({
        mode: 'legacy',
        diagnosticCode: 'pty-revive-outcome-unavailable',
        outcome: { outcomeVersion: 1, revived: [], lost: [RELAY_LOST_WORKER], diagnostics: [] }
      })
    } else {
      revive.mockResolvedValue({
        mode: 'typed',
        outcome: { outcomeVersion: 1, revived: [], lost: [lost], diagnostics: [] }
      })
    }
    archiveLostTerminalWorkerMock.mockResolvedValue(
      state === 'archive failure'
        ? { kind: 'error', code: 'durability-failed' }
        : {
            kind: 'archived',
            archive: {},
            operationId: 'relay-worker-lost:tab-1',
            ptyIdsToKill: [RELAY_LOST_WORKER.id]
          }
    )
    mockStore.getWorkspaceSession = vi
      .fn()
      .mockReturnValue(
        workspaceSessionForRelayLostWorker(state === 'typed unclassified worker hint')
      )
    const archived = state === 'typed recognized' || state === 'typed unclassified worker hint'
    const fallbackPtyIds = archived ? [] : ['ssh:target-1@@pty-fallback']
    const { attachForReconnect } = configureStagedPtyRevive({
      serialize,
      revive,
      reattachPtyIds: fallbackPtyIds
    })

    await session.reconnect(mockConn)

    expect(serialize).toHaveBeenCalledWith(['pty-lost'], { formatVersion: 2 })
    expect(revive).toHaveBeenCalledTimes(state === 'serialize failure' ? 0 : 1)
    expect(archiveLostTerminalWorkerMock).toHaveBeenCalledTimes(
      archived || state === 'archive failure' ? 1 : 0
    )
    expect(mockStore.markSshRemotePtyLease).toHaveBeenCalledTimes(
      archived ? 1 : fallbackPtyIds.length
    )
    expect(mockStore.markSshRemotePtyLease).toHaveBeenCalledWith(
      'target-1',
      archived ? 'pty-lost' : 'pty-fallback',
      archived ? 'expired' : 'attached'
    )
    expect(routeExternalPtyExit).toHaveBeenCalledTimes(archived ? 1 : 0)
    expect(session.getState()).toBe('ready')
    if (state === 'typed unclassified') {
      expect(mockStore.getWorkspaceSession).toHaveBeenCalledWith('ssh:target-1')
    }
    if (state === 'typed unclassified worker hint') {
      expect(archiveLostTerminalWorkerMock).toHaveBeenCalledWith(
        expect.objectContaining({
          candidate: expect.objectContaining({
            relayEvidence: expect.objectContaining({ kind: 'unclassified' })
          })
        })
      )
    }
    if (fallbackPtyIds.length > 0) {
      expect(attachForReconnect).toHaveBeenCalledWith('pty-fallback')
    }
    if (state === 'archive failure') {
      expect(archiveLostTerminalWorkerMock).toHaveBeenCalledWith(
        expect.objectContaining({
          candidate: expect.objectContaining({ relayEvidence: RELAY_LOST_WORKER })
        })
      )
      expect(mockStore.markSshRemotePtyLease).not.toHaveBeenCalledWith(
        'target-1',
        'pty-lost',
        'expired'
      )
    }
  })

  it('forwards reconnect replay after the attach attempt is still current', async () => {
    const { mockConn, session } = await establishRelaySession()
    vi.clearAllMocks()
    mockDeploySuccess()

    const mockAttach = vi.fn().mockResolvedValue({ replay: 'restored-output' })
    mockReconnectPtyProvider(mockAttach)
    vi.mocked(getPtyIdsForConnection).mockReturnValue(['pty-1'])

    await session.reconnect(mockConn)

    expect(routeExternalPtyReplay).toHaveBeenCalledWith({
      id: 'ssh:target-1@@pty-1',
      data: 'restored-output'
    })
  })

  it('drops identical reconnect replay payloads inside one reconnect burst', async () => {
    const { mockConn, session } = await establishRelaySession()
    vi.clearAllMocks()
    mockDeploySuccess()

    const mockAttach = vi.fn().mockResolvedValue({ replay: 'same-output' })
    mockReconnectPtyProvider(mockAttach)
    vi.mocked(getPtyIdsForConnection).mockReturnValue(['pty-1'])

    await session.reconnect(mockConn)
    await session.reconnect(mockConn)

    expect(mockAttach).toHaveBeenCalledTimes(2)
    expect(routeExternalPtyReplay).toHaveBeenCalledTimes(1)
  })

  it('establish re-attaches owned PTYs after explicit disconnect', async () => {
    const { mockConn, mockStore, mockPortForward, getMainWindow } = createMockDeps()
    const mockAttach = vi.fn().mockResolvedValue(undefined)
    mockReconnectPtyProvider(mockAttach)
    vi.mocked(getPtyIdsForConnection).mockReturnValue(['ssh:target-1@@pty-1'])

    const session = new SshRelaySession('target-1', getMainWindow, mockStore, mockPortForward)

    await session.establish(mockConn)

    expect(mockAttach).toHaveBeenCalledWith('pty-1')
    expect(setPtyOwnership).toHaveBeenCalledWith('ssh:target-1@@pty-1', 'target-1')
    expect(mockStore.markSshRemotePtyLease).toHaveBeenCalledWith('target-1', 'pty-1', 'attached')
  })

  it('establish re-attaches durable leases after app restart', async () => {
    const { mockConn, mockStore, mockPortForward, getMainWindow } = createMockDeps()
    const mockAttach = vi.fn().mockResolvedValue(undefined)
    mockReconnectPtyProvider(mockAttach)
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
    const mockAttach = vi.fn().mockResolvedValue(undefined)
    mockReconnectPtyProvider(mockAttach)
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
    const mockAttach = vi.fn().mockResolvedValue(undefined)
    mockReconnectPtyProvider(mockAttach)
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
    const { mockConn, mockStore, session } = await establishRelaySession()
    vi.clearAllMocks()
    mockDeploySuccess()

    const mockAttach = vi
      .fn()
      .mockRejectedValueOnce(new Error('PTY "pty-1" not found (identity mismatch)'))
    mockReconnectPtyProvider(mockAttach)
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
    expect(routeExternalPtyExit).not.toHaveBeenCalledWith({ id: 'ssh:target-1@@pty-1', code: -1 })
  })

  it('rejects establish if detach wins while reattach is in flight', async () => {
    const { mockConn, mockStore, mockPortForward, getMainWindow } = createMockDeps()
    let resolveAttach!: () => void
    const mockAttach = vi.fn().mockReturnValue(
      new Promise<void>((resolve) => {
        resolveAttach = resolve
      })
    )
    mockReconnectPtyProvider(mockAttach)
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
    const { mockConn, mockStore, session } = await establishRelaySession()
    vi.clearAllMocks()
    mockDeploySuccess()

    let resolveAttach!: () => void
    const mockAttach = vi.fn().mockReturnValue(
      new Promise<void>((resolve) => {
        resolveAttach = resolve
      })
    )
    mockReconnectPtyProvider(mockAttach)
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
    const { mockConn, session } = await establishRelaySession()
    vi.clearAllMocks()
    mockDeploySuccess()

    const mockAttach = vi
      .fn()
      .mockRejectedValueOnce(new Error('PTY "pty-stale" not found'))
      .mockResolvedValueOnce(undefined)
    mockReconnectPtyProvider(mockAttach)
    vi.mocked(getPtyIdsForConnection).mockReturnValue(['pty-stale', 'pty-live'])

    await session.reconnect(mockConn)

    expect(mockAttach).toHaveBeenCalledWith('pty-stale')
    expect(mockAttach).toHaveBeenCalledWith('pty-live')
    expect(clearProviderPtyState).toHaveBeenCalledWith('ssh:target-1@@pty-stale')
    expect(deletePtyOwnership).toHaveBeenCalledWith('ssh:target-1@@pty-stale')
    expect(routeExternalPtyExit).toHaveBeenCalledWith({
      id: 'ssh:target-1@@pty-stale',
      code: -1
    })
  })

  it('routes transient reattach failures through relay-lost retry handling', async () => {
    const { mockConn, mockStore, session } = await establishRelaySession()
    const onRelayLost = vi.fn()
    session.setOnRelayLost(onRelayLost)
    vi.clearAllMocks()
    mockDeploySuccess()

    const mockAttach = vi.fn().mockRejectedValue(new Error('Multiplexer disposed'))
    mockReconnectPtyProvider(mockAttach)
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
