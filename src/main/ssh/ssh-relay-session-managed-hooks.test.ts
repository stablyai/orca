import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AGENT_HOOK_INSTALL_MANAGED_HOOKS_METHOD,
  AGENT_HOOK_INSTALL_PLUGINS_METHOD
} from '../../shared/agent-hook-relay'
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

  it('retries without ZCode when an older relay rejects the expanded allowlist', async () => {
    let installAttempts = 0
    muxRequestMock.mockImplementation(async (method: string) => {
      if (method === 'preflight.detectAgents') {
        return { agents: ['codex', 'zcode'] }
      }
      if (method === AGENT_HOOK_INSTALL_MANAGED_HOOKS_METHOD) {
        installAttempts += 1
        if (installAttempts === 1) {
          throw new Error('remote request failed: invalid_managed_hook_agents')
        }
        return { installers: 1, errors: 0 }
      }
      return { ok: true }
    })
    const { mockStore, mockPortForward, getMainWindow } = createMockDeps()
    const connection = {
      sftp: vi.fn(),
      getHostKeyFingerprint: vi.fn(() => 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')
    } as unknown as SshConnection
    const session = new SshRelaySession('target-1', getMainWindow, mockStore, mockPortForward)

    await session.establish(connection)
    await vi.waitFor(() => expect(installAttempts).toBe(2))

    const installCalls = muxRequestMock.mock.calls.filter(
      ([method]) => method === AGENT_HOOK_INSTALL_MANAGED_HOOKS_METHOD
    )
    expect(installCalls.map(([, params]) => params)).toEqual([
      {
        hostKeyFingerprint: 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        agents: ['codex', 'zcode']
      },
      {
        hostKeyFingerprint: 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        agents: ['codex']
      }
    ])
    expect(registerSshPtyProvider).toHaveBeenCalled()
  })
})
