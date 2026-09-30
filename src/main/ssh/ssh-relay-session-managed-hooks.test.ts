import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AGENT_HOOK_INSTALL_MANAGED_HOOKS_METHOD,
  AGENT_HOOK_INSTALL_PLUGINS_METHOD
} from '../../shared/agent-hook-relay'
import { getDefaultSettings } from '../../shared/constants'
import type { Store } from '../persistence'
import { SSH_RELAY_PLUGIN_INSTALL_RETRY_DELAY_MS, SshRelaySession } from './ssh-relay-session'
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

  it('retries failed plugin installation on settings change and re-reads latest settings', async () => {
    vi.useFakeTimers()
    try {
      muxRequestMock.mockResolvedValue({ agents: [] })
      const { mockStore, mockConn, mockPortForward, getMainWindow } = createMockDeps()
      const settings = getDefaultSettings('/synthetic-home')
      mockStore.getSettings = () => settings
      let listener: Parameters<Store['onSettingsChanged']>[0] | undefined
      mockStore.onSettingsChanged = (callback) => {
        listener = callback
        return () => {}
      }
      const session = new SshRelaySession(
        'target-settings-retry',
        getMainWindow,
        mockStore,
        mockPortForward
      )
      await session.establish(mockConn)

      let attempt = 0
      muxRequestMock.mockImplementation(async (method: string) => {
        if (method === AGENT_HOOK_INSTALL_PLUGINS_METHOD) {
          attempt++
          if (attempt === 1) {
            throw { code: 'SSH_MUX_REQUEST_TIMEOUT', message: 'request timed out' }
          }
          return { ok: true }
        }
        return { ok: true }
      })

      settings.disabledTuiAgents = ['opencode']
      listener?.({ disabledTuiAgents: settings.disabledTuiAgents }, settings)
      await Promise.resolve()
      expect(attempt).toBe(1)

      // Settings updated again before retry fires
      settings.disabledTuiAgents = ['opencode2']

      await vi.advanceTimersByTimeAsync(SSH_RELAY_PLUGIN_INSTALL_RETRY_DELAY_MS)

      expect(attempt).toBe(2)
      const lastCall = muxRequestMock.mock.calls.findLast(
        ([method]) => method === AGENT_HOOK_INSTALL_PLUGINS_METHOD
      )
      expect(lastCall?.[1]).toMatchObject({
        opencodePluginSource: expect.stringContaining('/hook/opencode'),
        opencode2PluginSource: ''
      })

      session.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels pending plugin installation retry on session teardown', async () => {
    vi.useFakeTimers()
    try {
      muxRequestMock.mockResolvedValue({ agents: [] })
      const { mockStore, mockConn, mockPortForward, getMainWindow } = createMockDeps()
      const settings = getDefaultSettings('/synthetic-home')
      mockStore.getSettings = () => settings
      let listener: Parameters<Store['onSettingsChanged']>[0] | undefined
      mockStore.onSettingsChanged = (callback) => {
        listener = callback
        return () => {}
      }
      const session = new SshRelaySession(
        'target-settings-cancel',
        getMainWindow,
        mockStore,
        mockPortForward
      )
      await session.establish(mockConn)

      let calls = 0
      muxRequestMock.mockImplementation(async (method: string) => {
        if (method === AGENT_HOOK_INSTALL_PLUGINS_METHOD) {
          calls++
          throw { code: 'SSH_MUX_REQUEST_TIMEOUT', message: 'request timed out' }
        }
        return { ok: true }
      })

      settings.disabledTuiAgents = ['opencode']
      listener?.({ disabledTuiAgents: settings.disabledTuiAgents }, settings)
      await Promise.resolve()
      expect(calls).toBe(1)

      session.dispose()

      await vi.advanceTimersByTimeAsync(SSH_RELAY_PLUGIN_INSTALL_RETRY_DELAY_MS * 5)

      expect(calls).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not retry permanent errors such as byte cap exceeded', async () => {
    vi.useFakeTimers()
    try {
      muxRequestMock.mockResolvedValue({ agents: [] })
      const { mockStore, mockConn, mockPortForward, getMainWindow } = createMockDeps()
      const settings = getDefaultSettings('/synthetic-home')
      mockStore.getSettings = () => settings
      let listener: Parameters<Store['onSettingsChanged']>[0] | undefined
      mockStore.onSettingsChanged = (callback) => {
        listener = callback
        return () => {}
      }
      const session = new SshRelaySession(
        'target-settings-permanent-error',
        getMainWindow,
        mockStore,
        mockPortForward
      )
      await session.establish(mockConn)

      let calls = 0
      muxRequestMock.mockImplementation(async (method: string) => {
        if (method === AGENT_HOOK_INSTALL_PLUGINS_METHOD) {
          calls++
          throw new Error('opencodePluginSource exceeds 262144 byte cap')
        }
        return { ok: true }
      })

      settings.disabledTuiAgents = ['opencode']
      listener?.({ disabledTuiAgents: settings.disabledTuiAgents }, settings)
      await Promise.resolve()
      expect(calls).toBe(1)

      await vi.advanceTimersByTimeAsync(SSH_RELAY_PLUGIN_INSTALL_RETRY_DELAY_MS * 5)
      expect(calls).toBe(1)

      session.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels superseded in-flight installs and prevents overlapping retries', async () => {
    vi.useFakeTimers()
    try {
      muxRequestMock.mockResolvedValue({ agents: [] })
      const { mockStore, mockConn, mockPortForward, getMainWindow } = createMockDeps()
      const settings = getDefaultSettings('/synthetic-home')
      mockStore.getSettings = () => settings
      let listener: Parameters<Store['onSettingsChanged']>[0] | undefined
      mockStore.onSettingsChanged = (callback) => {
        listener = callback
        return () => {}
      }
      const session = new SshRelaySession(
        'target-settings-overlapping',
        getMainWindow,
        mockStore,
        mockPortForward
      )
      await session.establish(mockConn)

      let deferredReject1: ((err: unknown) => void) | undefined
      let deferredReject2: ((err: unknown) => void) | undefined
      let calls = 0

      muxRequestMock.mockImplementation(async (method: string) => {
        if (method === AGENT_HOOK_INSTALL_PLUGINS_METHOD) {
          calls++
          if (calls === 1) {
            return new Promise((_, reject) => {
              deferredReject1 = reject
            })
          }
          if (calls === 2) {
            return new Promise((_, reject) => {
              deferredReject2 = reject
            })
          }
          return { ok: true }
        }
        return { ok: true }
      })

      // First settings change starts call 1
      settings.disabledTuiAgents = ['opencode']
      listener?.({ disabledTuiAgents: settings.disabledTuiAgents }, settings)
      expect(calls).toBe(1)

      // Second settings change starts call 2 before call 1 finishes
      settings.disabledTuiAgents = ['opencode2']
      listener?.({ disabledTuiAgents: settings.disabledTuiAgents }, settings)
      expect(calls).toBe(2)

      // Call 1 fails after Call 2 started: should be ignored because it is superseded
      deferredReject1?.({ code: 'ETIMEDOUT', message: 'timeout 1' })
      await Promise.resolve()

      // Call 2 fails: should schedule a single retry
      deferredReject2?.({ code: 'ETIMEDOUT', message: 'timeout 2' })
      await Promise.resolve()

      // Advance time to allow retry of Call 2
      await vi.advanceTimersByTimeAsync(SSH_RELAY_PLUGIN_INSTALL_RETRY_DELAY_MS)
      expect(calls).toBe(3)

      // Ensure no second overlapping retry fires
      await vi.advanceTimersByTimeAsync(SSH_RELAY_PLUGIN_INSTALL_RETRY_DELAY_MS)
      expect(calls).toBe(3)

      session.dispose()
    } finally {
      vi.useRealTimers()
    }
  })
})
