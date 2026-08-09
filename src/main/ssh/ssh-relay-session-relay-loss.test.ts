import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SshRelaySession } from './ssh-relay-session'
import type { SshConnection } from './ssh-connection'
import { SSH_RELAY_CONFIGURE_GRACE_TIME_METHOD } from '../../shared/ssh-types'
import { createMockDeps, mockDeploySuccess } from './ssh-relay-session-test-fixtures'

// #11953: the grace-time notify is the last thing establish()/reconnect() do
// before latching 'ready', and it can dispose the mux synchronously (writer
// admission cap / throwing transport). Latching 'ready' there left the status
// bar on "connected" with fs/pty/git providers bound to a dead mux and no
// relay-loss watcher, so nothing ever scheduled a reconnect.

const { muxRequestMock, openConsumerSessionMock, registeredPtyProvider } = vi.hoisted(() => ({
  muxRequestMock: vi.fn(),
  openConsumerSessionMock: vi.fn(),
  registeredPtyProvider: { dispose: vi.fn(), attachForReconnect: vi.fn() }
}))

vi.mock('./ssh-relay-deploy', () => ({ deployAndLaunchRelay: vi.fn() }))
vi.mock('./ssh-pty-consumer-session', () => ({
  openSshPtyConsumerSession: openConsumerSessionMock
}))
vi.mock('../ipc/ssh-pty-output-intake-registry', () => ({
  acceptSshPtyOutputData: vi.fn().mockResolvedValue(undefined),
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

// Mirrors the real multiplexer contract: dispose() latches, and a failed write
// during notify disposes the mux synchronously via handleProtocolError.
vi.mock('./ssh-channel-multiplexer', () => ({
  SshChannelMultiplexer: class MockSshChannelMultiplexer {
    private disposed = false
    private disposeReason: string | null = null
    private disposeHandlers: ((reason: string) => void)[] = []
    /** Set by the test to kill the channel from inside notify(). */
    failNotifyMethod: string | null = null
    notify = vi.fn((method: string) => {
      if (method === this.failNotifyMethod) {
        this.dispose('connection_lost')
      }
    })
    notifyWithSettlement = vi.fn()
    request = muxRequestMock
    onNotification = vi.fn().mockReturnValue(() => {})
    onNotificationByMethod = vi.fn().mockReturnValue(() => {})
    onRequest = vi.fn().mockReturnValue(() => {})
    onDispose = vi.fn((handler: (reason: string) => void) => {
      if (this.disposed) {
        handler(this.disposeReason ?? 'shutdown')
        return () => {}
      }
      this.disposeHandlers.push(handler)
      return () => {
        const idx = this.disposeHandlers.indexOf(handler)
        if (idx !== -1) {
          this.disposeHandlers.splice(idx, 1)
        }
      }
    })
    dispose = vi.fn((reason = 'shutdown') => {
      if (this.disposed) {
        return
      }
      this.disposed = true
      this.disposeReason = reason
      for (const handler of this.disposeHandlers.splice(0)) {
        handler(reason)
      }
    })
    isDisposed = vi.fn(() => this.disposed)
  }
}))

vi.mock('../providers/ssh-pty-provider', () => ({
  isSshPtyNotFoundError: () => false,
  isSshPtyIdentityMismatchError: () => false,
  SshPtyProvider: class MockSshPtyProvider {
    onData = vi.fn().mockReturnValue(() => {})
    onReplay = vi.fn().mockReturnValue(() => {})
    onExit = vi.fn().mockReturnValue(() => {})
    attach = vi.fn().mockResolvedValue(undefined)
    attachForReconnect = vi.fn().mockResolvedValue({})
    setPtyDeliveryPauseAdapter = vi.fn()
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
  getSshPtyProvider: vi.fn().mockReturnValue(registeredPtyProvider),
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

const { registerSshFilesystemProvider, unregisterSshFilesystemProvider } =
  await import('../providers/ssh-filesystem-dispatch')
const { getPtyIdsForConnection } = await import('../ipc/pty')

describe('SshRelaySession relay loss during setup', () => {
  /** Armed by a test so the *next* mux dies inside its grace-time notify. */
  let armGraceTimeFailure = false
  let armProviderRegistrationFailure = false

  beforeEach(() => {
    vi.clearAllMocks()
    armGraceTimeFailure = false
    armProviderRegistrationFailure = false
    muxRequestMock.mockReset()
    vi.mocked(getPtyIdsForConnection).mockReturnValue([])
    registeredPtyProvider.attachForReconnect.mockReset().mockResolvedValue({})
    openConsumerSessionMock.mockImplementation(async (_mux, options) => ({
      mode: 'legacy-fallback',
      clientInstanceId: options.clientInstanceId,
      serverBuildId: 'test-relay-build'
    }))
    mockDeploySuccess()
  })

  function createSession(): {
    session: SshRelaySession
    onRelayLost: ReturnType<typeof vi.fn>
    onReady: ReturnType<typeof vi.fn>
    mockStore: ReturnType<typeof createMockDeps>['mockStore']
  } {
    const { mockStore, mockPortForward, getMainWindow } = createMockDeps()
    const session = new SshRelaySession('target-1', getMainWindow, mockStore, mockPortForward)
    const onRelayLost = vi.fn()
    const onReady = vi.fn()
    session.setOnRelayLost(onRelayLost)
    session.setOnReady(onReady)
    // Arm once the mux exists; every attempt issues requests before the notify.
    muxRequestMock.mockImplementation(async (method: string) => {
      const mux = session.getMux() as unknown as {
        failNotifyMethod: string | null
        dispose: (reason: string) => void
      } | null
      if (mux && armGraceTimeFailure) {
        mux.failNotifyMethod = SSH_RELAY_CONFIGURE_GRACE_TIME_METHOD
      }
      if (mux && armProviderRegistrationFailure && method === 'git.listWorktrees') {
        mux.dispose('connection_lost')
        throw new Error('SSH connection lost, reconnecting...')
      }
      return []
    })
    return { session, onRelayLost, onReady, mockStore }
  }

  it('fails establish instead of reporting ready on a dead channel', async () => {
    const { session, onReady } = createSession()
    armGraceTimeFailure = true

    await expect(session.establish({} as SshConnection)).rejects.toThrow(
      'Relay connection lost during establish'
    )

    expect(registerSshFilesystemProvider).toHaveBeenCalledWith('target-1', expect.anything())
    expect(session.getState()).not.toBe('ready')
    expect(onReady).not.toHaveBeenCalled()
    expect(unregisterSshFilesystemProvider).toHaveBeenCalledWith('target-1')
  })

  it('routes a dead channel during reconnect into relay-loss recovery', async () => {
    const { session, onRelayLost, onReady } = createSession()

    await session.establish({} as SshConnection)
    expect(session.getState()).toBe('ready')
    onReady.mockClear()

    armGraceTimeFailure = true
    await session.reconnect({} as SshConnection)

    expect(session.getState()).not.toBe('ready')
    expect(onReady).not.toHaveBeenCalled()
    expect(onRelayLost).toHaveBeenCalledTimes(1)
    expect(unregisterSshFilesystemProvider).toHaveBeenCalledWith('target-1')
  })

  it('routes a mux that dies during provider registration into relay-loss recovery', async () => {
    const { session, onRelayLost, onReady, mockStore } = createSession()

    await session.establish({} as SshConnection)
    expect(session.getState()).toBe('ready')
    onReady.mockClear()

    vi.mocked(mockStore.getRepos).mockReturnValue([
      { connectionId: 'target-1', path: '/repo' } as ReturnType<typeof mockStore.getRepos>[number]
    ])
    armProviderRegistrationFailure = true

    await session.reconnect({} as SshConnection)

    expect(session.getState()).not.toBe('ready')
    expect(onReady).not.toHaveBeenCalled()
    expect(onRelayLost).toHaveBeenCalledTimes(1)
    expect(unregisterSshFilesystemProvider).toHaveBeenCalledWith('target-1')
  })

  // #11953: reattachKnownPtys swallows every per-PTY failure, so a mux killed by the
  // reattach burst itself never reaches the catch — the post-reattach gate has to notice.
  it('routes a mux that dies during PTY reattach into relay-loss recovery', async () => {
    const { session, onRelayLost, onReady } = createSession()

    await session.establish({} as SshConnection)
    expect(session.getState()).toBe('ready')
    onReady.mockClear()

    vi.mocked(getPtyIdsForConnection).mockReturnValue(['pty-1'])
    registeredPtyProvider.attachForReconnect.mockImplementation(async () => {
      const mux = session.getMux() as unknown as { dispose: (reason: string) => void } | null
      mux?.dispose('connection_lost')
      throw new Error('SSH connection lost, reconnecting...')
    })

    await session.reconnect({} as SshConnection)

    expect(registeredPtyProvider.attachForReconnect).toHaveBeenCalled()
    expect(session.getState()).not.toBe('ready')
    expect(onReady).not.toHaveBeenCalled()
    expect(onRelayLost).toHaveBeenCalledTimes(1)
    expect(unregisterSshFilesystemProvider).toHaveBeenCalledWith('target-1')
  })
})
