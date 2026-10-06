import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AGENT_HOOK_INSTALL_MANAGED_HOOKS_METHOD,
  AGENT_HOOK_INSTALL_PLUGINS_METHOD
} from '../../shared/agent-hook-relay'
import { getDefaultSettings } from '../../shared/constants'
import type { Store } from '../persistence'
import { SshRelaySession } from './ssh-relay-session'
import type { SshConnection } from './ssh-connection'
import { createMockDeps, mockDeploySuccess } from './ssh-relay-session-test-fixtures'

const { muxRequestMock, openConsumerSessionMock } = vi.hoisted(() => ({
  muxRequestMock: vi.fn(),
  openConsumerSessionMock: vi.fn()
}))

vi.mock('./ssh-relay-deploy', () => ({ deployAndLaunchRelay: vi.fn() }))
vi.mock('./ssh-relay-deploy-helpers', () => ({ execCommand: vi.fn().mockResolvedValue('') }))
vi.mock('./ssh-pty-consumer-session', () => ({
  openSshPtyConsumerSession: openConsumerSessionMock
}))
vi.mock('./ssh-channel-multiplexer', () => ({
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
}))
vi.mock('../providers/ssh-pty-provider', () => ({
  isSshPtyNotFoundError: vi.fn(() => false),
  isSshPtyIdentityMismatchError: vi.fn(() => false),
  SshPtyProvider: class MockSshPtyProvider {
    onData = vi.fn().mockReturnValue(() => {})
    onReplay = vi.fn().mockReturnValue(() => {})
    onExit = vi.fn().mockReturnValue(() => {})
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
  getSshPtyProvider: vi.fn(),
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
  getSshFilesystemProvider: vi.fn()
}))
vi.mock('../providers/ssh-git-dispatch', () => ({
  registerSshGitProvider: vi.fn(),
  unregisterSshGitProvider: vi.fn()
}))

const { registerSshPtyProvider } = await import('../ipc/pty')

describe('SshRelaySession managed hooks', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.ORCA_FEATURE_REMOTE_AGENT_HOOKS = '1'
    openConsumerSessionMock.mockImplementation(async (_mux, options) => ({
      mode: 'legacy-fallback',
      clientInstanceId: options.clientInstanceId,
      serverBuildId: 'test-relay-build'
    }))
    mockDeploySuccess()
  })

  it('installs only detected hooks without blocking provider registration', async () => {
    muxRequestMock.mockImplementation(async (method: string) => {
      if (method === 'preflight.detectAgents') {
        return { agents: ['codex'] }
      }
      return method === AGENT_HOOK_INSTALL_MANAGED_HOOKS_METHOD
        ? { installers: 1, errors: 0 }
        : { ok: true }
    })
    const { mockStore, mockPortForward, getMainWindow } = createMockDeps()
    const sftp = vi.fn()
    const connection = {
      sftp,
      getHostKeyFingerprint: vi.fn(() => 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')
    } as unknown as SshConnection
    const session = new SshRelaySession('target-1', getMainWindow, mockStore, mockPortForward)

    await session.establish(connection)
    await vi.waitFor(() =>
      expect(muxRequestMock).toHaveBeenCalledWith(AGENT_HOOK_INSTALL_MANAGED_HOOKS_METHOD, {
        hostKeyFingerprint: 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        agents: ['codex']
      })
    )

    const managedIndex = muxRequestMock.mock.calls.findIndex(
      ([method]) => method === AGENT_HOOK_INSTALL_MANAGED_HOOKS_METHOD
    )
    const pluginsIndex = muxRequestMock.mock.calls.findIndex(
      ([method]) => method === AGENT_HOOK_INSTALL_PLUGINS_METHOD
    )
    expect(muxRequestMock.mock.calls[pluginsIndex]?.[1]).toMatchObject({
      opencode2PluginSource: expect.stringContaining('/hook/opencode2'),
      piExtensionSource: expect.stringContaining('/hook/pi'),
      ompExtensionSource: expect.stringContaining('/hook/omp'),
      primeAgentExtensionSource: expect.stringContaining('/hook/prime-agent')
    })
    expect(sftp).not.toHaveBeenCalled()
    expect(muxRequestMock.mock.invocationCallOrder[pluginsIndex]).toBeLessThan(
      vi.mocked(registerSshPtyProvider).mock.invocationCallOrder[0]
    )
    expect(vi.mocked(registerSshPtyProvider).mock.invocationCallOrder[0]).toBeLessThan(
      muxRequestMock.mock.invocationCallOrder[managedIndex]
    )
  })

  it('forwards the execution-host Claude version to the remote installer', async () => {
    muxRequestMock.mockImplementation(async (method: string) => {
      if (method === 'preflight.detectAgents') {
        return {
          agents: ['claude'],
          versions: { claude: '2.1.261 (Claude Code)' }
        }
      }
      return method === AGENT_HOOK_INSTALL_MANAGED_HOOKS_METHOD
        ? { installers: 1, errors: 0 }
        : { ok: true }
    })
    const { mockStore, mockPortForward, getMainWindow } = createMockDeps()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: establish only reads these mocked connection members in this harness.
    const connection = {
      sftp: vi.fn(),
      getHostKeyFingerprint: vi.fn(() => 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')
    } as unknown as SshConnection
    const session = new SshRelaySession('target-1', getMainWindow, mockStore, mockPortForward)

    await session.establish(connection)
    await vi.waitFor(() =>
      expect(muxRequestMock).toHaveBeenCalledWith(AGENT_HOOK_INSTALL_MANAGED_HOOKS_METHOD, {
        hostKeyFingerprint: 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        agents: ['claude'],
        claudeVersion: '2.1.261'
      })
    )
  })
  it('refreshes OpenCode sources on settings changes and releases its subscription', async () => {
    muxRequestMock.mockResolvedValue({ agents: [] })
    const { mockStore, mockConn, mockPortForward, getMainWindow } = createMockDeps()
    const settings = getDefaultSettings('/synthetic-home')
    settings.disabledTuiAgents = ['opencode']
    mockStore.getSettings = () => settings
    let listener: Parameters<Store['onSettingsChanged']>[0] | undefined
    const cleanup = vi.fn(() => {
      listener = undefined
    })
    mockStore.onSettingsChanged = (callback) => {
      listener = callback
      return cleanup
    }
    const session = new SshRelaySession(
      'target-settings',
      getMainWindow,
      mockStore,
      mockPortForward
    )
    await session.establish(mockConn)
    const lastSources = () =>
      muxRequestMock.mock.calls.findLast(
        ([method]) => method === AGENT_HOOK_INSTALL_PLUGINS_METHOD
      )?.[1]
    expect(lastSources()).toMatchObject({
      opencodePluginSource: '',
      opencode2PluginSource: expect.stringContaining('/hook/opencode2')
    })
    settings.disabledTuiAgents = ['opencode2']
    listener?.({ disabledTuiAgents: settings.disabledTuiAgents }, settings)
    expect(lastSources()).toMatchObject({
      opencodePluginSource: expect.stringContaining('/hook/opencode'),
      opencode2PluginSource: ''
    })
    settings.agentStatusHooksEnabled = false
    listener?.({ agentStatusHooksEnabled: false }, settings)
    expect(lastSources()).toMatchObject({ opencodePluginSource: '', opencode2PluginSource: '' })
    session.dispose()
    expect(cleanup).toHaveBeenCalledOnce()
  })

  // Why: a timed-out install left the relay on the old sources (a disabled agent kept its plugin) until the next reconnect.
  it('retries a settings-triggered plugin install that failed, using the latest settings', async () => {
    muxRequestMock.mockResolvedValue({ agents: [] })
    const { mockStore, mockConn, mockPortForward, getMainWindow } = createMockDeps()
    const settings = getDefaultSettings('/synthetic-home')
    mockStore.getSettings = () => settings
    let listener: Parameters<Store['onSettingsChanged']>[0] | undefined
    mockStore.onSettingsChanged = (callback) => {
      listener = callback
      return vi.fn()
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const session = new SshRelaySession(
      'target-settings',
      getMainWindow,
      mockStore,
      mockPortForward
    )
    await session.establish(mockConn)
    const installCalls = () =>
      muxRequestMock.mock.calls.filter(([method]) => method === AGENT_HOOK_INSTALL_PLUGINS_METHOD)

    vi.useFakeTimers()
    try {
      const before = installCalls().length
      muxRequestMock.mockImplementationOnce(async (method: string) => {
        if (method !== AGENT_HOOK_INSTALL_PLUGINS_METHOD) {
          return { agents: [] }
        }
        throw Object.assign(new Error('timed out'), { code: 'SSH_MUX_REQUEST_TIMEOUT' })
      })
      settings.disabledTuiAgents = ['opencode2']
      listener?.({ disabledTuiAgents: settings.disabledTuiAgents }, settings)
      await vi.advanceTimersByTimeAsync(60_000)

      const calls = installCalls().slice(before)
      expect(calls.length).toBeGreaterThan(1)
      expect(calls.at(-1)?.[1]).toMatchObject({ opencode2PluginSource: '' })
    } finally {
      vi.useRealTimers()
      warn.mockRestore()
      session.dispose()
    }
  })

  // Why: two overlapping failed installs must leave one retry chain, not two the next install can't cancel.
  it('retries once when overlapping settings-triggered installs both fail', async () => {
    muxRequestMock.mockResolvedValue({ agents: [] })
    const { mockStore, mockConn, mockPortForward, getMainWindow } = createMockDeps()
    const settings = getDefaultSettings('/synthetic-home')
    mockStore.getSettings = () => settings
    let listener: Parameters<Store['onSettingsChanged']>[0] | undefined
    mockStore.onSettingsChanged = (callback) => {
      listener = callback
      return vi.fn()
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const session = new SshRelaySession(
      'target-settings',
      getMainWindow,
      mockStore,
      mockPortForward
    )
    await session.establish(mockConn)
    const installCalls = () =>
      muxRequestMock.mock.calls.filter(([method]) => method === AGENT_HOOK_INSTALL_PLUGINS_METHOD)

    vi.useFakeTimers()
    try {
      const before = installCalls().length
      const pendingInstalls: ((error: Error) => void)[] = []
      muxRequestMock.mockImplementation((method: string) => {
        if (method === AGENT_HOOK_INSTALL_PLUGINS_METHOD && pendingInstalls.length < 2) {
          return new Promise((_resolve, reject) => pendingInstalls.push(reject))
        }
        return Promise.resolve({ agents: [] })
      })
      settings.disabledTuiAgents = ['opencode2']
      listener?.({ disabledTuiAgents: settings.disabledTuiAgents }, settings)
      settings.disabledTuiAgents = ['opencode']
      listener?.({ disabledTuiAgents: settings.disabledTuiAgents }, settings)
      expect(pendingInstalls).toHaveLength(2)

      for (const reject of pendingInstalls) {
        reject(Object.assign(new Error('timed out'), { code: 'SSH_MUX_REQUEST_TIMEOUT' }))
      }
      await vi.advanceTimersByTimeAsync(60_000)

      expect(installCalls().slice(before)).toHaveLength(3)
    } finally {
      vi.useRealTimers()
      warn.mockRestore()
      session.dispose()
    }
  })
  it.each(['PERMISSION_DENIED', -32601, 'CONNECTION_LOST', 'DISPOSED'])(
    'does not retry permanent or retired transport failure %s',
    async (code) => {
      muxRequestMock.mockResolvedValue({ agents: [] })
      const { mockStore, mockConn, mockPortForward, getMainWindow } = createMockDeps()
      const settings = getDefaultSettings('/synthetic-home')
      mockStore.getSettings = () => settings
      let listener: Parameters<Store['onSettingsChanged']>[0] | undefined
      mockStore.onSettingsChanged = (callback) => {
        listener = callback
        return vi.fn()
      }
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const session = new SshRelaySession(
        'target-no-retry',
        getMainWindow,
        mockStore,
        mockPortForward
      )
      await session.establish(mockConn)
      warn.mockClear()
      vi.useFakeTimers()
      try {
        const before = muxRequestMock.mock.calls.filter(
          ([method]) => method === AGENT_HOOK_INSTALL_PLUGINS_METHOD
        ).length
        muxRequestMock.mockRejectedValueOnce(Object.assign(new Error('controlled error'), { code }))
        listener?.({ disabledTuiAgents: ['opencode2'] }, settings)
        await vi.advanceTimersByTimeAsync(60_000)
        expect(
          muxRequestMock.mock.calls.filter(
            ([method]) => method === AGENT_HOOK_INSTALL_PLUGINS_METHOD
          )
        ).toHaveLength(before + 1)
        expect(warn).toHaveBeenCalledTimes(code === 'PERMISSION_DENIED' ? 1 : 0)
      } finally {
        vi.useRealTimers()
        warn.mockRestore()
        session.dispose()
      }
    }
  )
  it.each([false, true])(
    'bounds timeout retries and cancels them on disposal=%s',
    async (dispose) => {
      muxRequestMock.mockResolvedValue({ agents: [] })
      const { mockStore, mockConn, mockPortForward, getMainWindow } = createMockDeps()
      const settings = getDefaultSettings('/synthetic-home')
      mockStore.getSettings = () => settings
      let listener: Parameters<Store['onSettingsChanged']>[0] | undefined
      mockStore.onSettingsChanged = (callback) => {
        listener = callback
        return vi.fn()
      }
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const session = new SshRelaySession(
        'target-bounded',
        getMainWindow,
        mockStore,
        mockPortForward
      )
      await session.establish(mockConn)
      const before = muxRequestMock.mock.calls.filter(
        ([method]) => method === AGENT_HOOK_INSTALL_PLUGINS_METHOD
      ).length
      muxRequestMock.mockImplementation(async (method) => {
        if (method === AGENT_HOOK_INSTALL_PLUGINS_METHOD) {
          throw Object.assign(new Error('timeout'), { code: 'SSH_MUX_REQUEST_TIMEOUT' })
        }
        return { agents: [] }
      })
      vi.useFakeTimers()
      try {
        listener?.({ disabledTuiAgents: ['opencode2'] }, settings)
        if (dispose) {
          session.dispose()
        }
        await vi.advanceTimersByTimeAsync(60_000)
        expect(
          muxRequestMock.mock.calls.filter(
            ([method]) => method === AGENT_HOOK_INSTALL_PLUGINS_METHOD
          )
        ).toHaveLength(before + (dispose ? 1 : 4))
      } finally {
        vi.useRealTimers()
        warn.mockRestore()
        session.dispose()
      }
    }
  )
})
