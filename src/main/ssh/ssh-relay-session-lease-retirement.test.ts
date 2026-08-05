import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SshRelaySession } from './ssh-relay-session'
import { createMockDeps, mockDeploySuccess } from './ssh-relay-session-test-fixtures'

const { acceptOutputExitMock, muxRequestMock } = vi.hoisted(() => ({
  acceptOutputExitMock: vi.fn().mockResolvedValue(undefined),
  muxRequestMock: vi.fn()
}))

vi.mock('./ssh-relay-deploy', () => ({ deployAndLaunchRelay: vi.fn() }))
vi.mock('./ssh-pty-consumer-session', () => ({
  openSshPtyConsumerSession: vi.fn(async (_mux, options) => ({
    clientInstanceId: options.clientInstanceId,
    clientGeneration: 1,
    ownerGeneration: 1,
    ownerLease: 'test-owner-lease'
  }))
}))
vi.mock('../ipc/ssh-pty-output-intake-registry', () => ({
  acceptSshPtyOutputData: vi.fn().mockResolvedValue(undefined),
  acceptSshPtyOutputExit: acceptOutputExitMock,
  allocateSshPtyProviderGeneration: vi.fn(() => 31),
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
vi.mock('./ssh-relay-deploy-helpers', () => ({ execCommand: vi.fn().mockResolvedValue('') }))
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
vi.mock('../agent-hooks/remote-managed-hook-installers', () => ({
  installRemoteManagedAgentHooks: vi.fn().mockResolvedValue([])
}))
vi.mock('../providers/ssh-pty-provider', () => ({
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
  restorePtyIncarnation: vi.fn(),
  isCurrentPtyExit: vi.fn(() => true),
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

const { getPtyIdsForConnection } = await import('../ipc/pty')

describe('SSH relay lease retirement and orphan reaping', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    muxRequestMock.mockResolvedValue([])
    mockDeploySuccess()
  })

  // D7: `relay.status` is answered by the detached daemon that owns the PTYs, even through `--connect`.
  const relayStatus =
    (pid: number, uptimeMs: number, incarnationToken?: string) => (method: string) =>
      method === 'relay.status'
        ? Promise.resolve({ pid, uptimeMs, ...(incarnationToken ? { incarnationToken } : {}) })
        : Promise.resolve([])

  /** D3 only reaps within the incarnation that minted the flags, so a drain test must prove one. */
  const armReapDrain = (mockStore: ReturnType<typeof createMockDeps>['mockStore']): void => {
    muxRequestMock.mockImplementation(relayStatus(4242, 60_000, 'tok-a'))
    vi.mocked(mockStore.getSshRelayIncarnation).mockReturnValue({
      targetId: 'target-1',
      pid: 4242,
      derivedStartAt: Date.now() - 60_000,
      token: 'tok-a'
    })
  }

  it('reaps orphaned remote PTYs on connect and clears the flag once the relay accepts', async () => {
    const { mockConn, mockStore, mockPortForward, getMainWindow } = createMockDeps()
    const { getSshPtyProvider } = await import('../ipc/pty')
    const mockShutdown = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('relay unreachable'))
    vi.mocked(getSshPtyProvider).mockReturnValue({
      attachForReconnect: vi.fn().mockResolvedValue(undefined),
      shutdown: mockShutdown,
      hasPty: vi.fn().mockReturnValue(false),
      dispose: vi.fn()
    } as unknown as ReturnType<typeof getSshPtyProvider>)
    vi.mocked(getPtyIdsForConnection).mockReturnValue([])
    vi.mocked(mockStore.claimSshRemotePtyLeasesToReap).mockReturnValue(['pty-dead', 'pty-stuck'])
    armReapDrain(mockStore)

    const session = new SshRelaySession('target-1', getMainWindow, mockStore, mockPortForward)
    await session.establish(mockConn)

    expect(mockShutdown).toHaveBeenCalledWith('ssh:target-1@@pty-dead', {
      immediate: true,
      keepHistory: false
    })
    expect(mockStore.clearSshRemotePtyLeaseReapFlag).toHaveBeenCalledWith('target-1', 'pty-dead')
    // Why: a failed kill keeps its flag, so the next connect retries it.
    expect(mockStore.clearSshRemotePtyLeaseReapFlag).not.toHaveBeenCalledWith(
      'target-1',
      'pty-stuck'
    )
  })

  it('spares a flagged id this connection is live on, since a reset relay reuses pty-N', async () => {
    const { mockConn, mockStore, mockPortForward, getMainWindow } = createMockDeps()
    const { getSshPtyProvider } = await import('../ipc/pty')
    const mockShutdown = vi.fn().mockResolvedValue(undefined)
    vi.mocked(getSshPtyProvider).mockReturnValue({
      attachForReconnect: vi.fn().mockResolvedValue(undefined),
      shutdown: mockShutdown,
      hasPty: vi.fn().mockImplementation((id: string) => id === 'ssh:target-1@@pty-1'),
      dispose: vi.fn()
    } as unknown as ReturnType<typeof getSshPtyProvider>)
    vi.mocked(getPtyIdsForConnection).mockReturnValue([])
    vi.mocked(mockStore.claimSshRemotePtyLeasesToReap).mockReturnValue(['pty-1'])
    armReapDrain(mockStore)

    const session = new SshRelaySession('target-1', getMainWindow, mockStore, mockPortForward)
    await session.establish(mockConn)

    expect(mockShutdown).not.toHaveBeenCalled()
    expect(mockStore.clearSshRemotePtyLeaseReapFlag).toHaveBeenCalledWith('target-1', 'pty-1')
  })

  it('treats an already-gone remote PTY as a successful reap', async () => {
    const { mockConn, mockStore, mockPortForward, getMainWindow } = createMockDeps()
    const { getSshPtyProvider } = await import('../ipc/pty')
    const notFound = new Error('PTY "pty-gone" not found')
    vi.mocked(getSshPtyProvider).mockReturnValue({
      attachForReconnect: vi.fn().mockResolvedValue(undefined),
      shutdown: vi.fn().mockRejectedValue(notFound),
      hasPty: vi.fn().mockReturnValue(false),
      dispose: vi.fn()
    } as unknown as ReturnType<typeof getSshPtyProvider>)
    vi.mocked(getPtyIdsForConnection).mockReturnValue([])
    vi.mocked(mockStore.claimSshRemotePtyLeasesToReap).mockReturnValue(['pty-gone'])
    armReapDrain(mockStore)

    const session = new SshRelaySession('target-1', getMainWindow, mockStore, mockPortForward)
    await session.establish(mockConn)

    expect(mockStore.clearSshRemotePtyLeaseReapFlag).toHaveBeenCalledWith('target-1', 'pty-gone')
  })

  // D6/RC4b: the relay sends one message that satisfies both the not-found and the mismatch predicate,
  // so this exit is reachable and used to return without retiring anything.
  it('retires an identity-mismatched lease without touching the PTY or the live pane it names', async () => {
    const { mockConn, mockStore, mockPortForward, getMainWindow, mockWindow } = createMockDeps()
    const { getSshPtyProvider, clearProviderPtyState, deletePtyOwnership } =
      await import('../ipc/pty')
    vi.mocked(getSshPtyProvider).mockReturnValue({
      attachForReconnect: vi
        .fn()
        .mockRejectedValue(new Error('PTY "pty-1" not found (identity mismatch)')),
      dispose: vi.fn()
    } as unknown as ReturnType<typeof getSshPtyProvider>)
    vi.mocked(getPtyIdsForConnection).mockReturnValue(['pty-1'])

    const session = new SshRelaySession('target-1', getMainWindow, mockStore, mockPortForward)
    await session.establish(mockConn)

    expect(mockStore.retireLeaseSparingPty).toHaveBeenCalledWith(
      'target-1',
      'pty-1',
      expect.stringContaining('identity mismatch')
    )
    expect(mockStore.retireLeaseAndReap).not.toHaveBeenCalled()
    // Why: after the fence, `ssh:target-1@@pty-1` is the *other* pane's app id, so local teardown here
    // would kill a working pane.
    expect(clearProviderPtyState).not.toHaveBeenCalled()
    expect(deletePtyOwnership).not.toHaveBeenCalled()
    expect(mockWindow.webContents.send).not.toHaveBeenCalledWith('pty:exit', expect.anything())
  })

  it('retires a plainly missing PTY through the sparing primitive too', async () => {
    const { mockConn, mockStore, mockPortForward, getMainWindow } = createMockDeps()
    const { getSshPtyProvider, deletePtyOwnership } = await import('../ipc/pty')
    vi.mocked(getSshPtyProvider).mockReturnValue({
      attachForReconnect: vi.fn().mockRejectedValue(new Error('PTY "pty-1" not found')),
      dispose: vi.fn()
    } as unknown as ReturnType<typeof getSshPtyProvider>)
    vi.mocked(getPtyIdsForConnection).mockReturnValue(['pty-1'])

    const session = new SshRelaySession('target-1', getMainWindow, mockStore, mockPortForward)
    await session.establish(mockConn)

    expect(mockStore.retireLeaseSparingPty).toHaveBeenCalledWith(
      'target-1',
      'pty-1',
      expect.stringContaining('not found')
    )
    expect(mockStore.retireLeaseAndReap).not.toHaveBeenCalled()
    expect(deletePtyOwnership).toHaveBeenCalledWith('ssh:target-1@@pty-1')
  })

  it('retires every lease for the target when a different relay incarnation owns the socket', async () => {
    const { mockConn, mockStore, mockPortForward, getMainWindow } = createMockDeps()
    muxRequestMock.mockImplementation(relayStatus(4242, 1_000))
    vi.mocked(mockStore.getSshRelayIncarnation).mockReturnValue({
      targetId: 'target-1',
      pid: 111,
      derivedStartAt: Date.now() - 900_000
    })

    const session = new SshRelaySession('target-1', getMainWindow, mockStore, mockPortForward)
    await session.establish(mockConn)

    expect(mockStore.retireAllLeasesSparingPtys).toHaveBeenCalledWith(
      'target-1',
      expect.stringContaining('relay incarnation changed')
    )
    expect(mockStore.setSshRelayIncarnation).toHaveBeenCalledWith(
      expect.objectContaining({ targetId: 'target-1', pid: 4242 })
    )
    // Two durable writes: recording the new owner first would let a crash in between turn the next
    // connect into a "same incarnation" no-op that never retires the old incarnation's leases.
    expect(vi.mocked(mockStore.setSshRelayIncarnation).mock.invocationCallOrder[0]).toBeGreaterThan(
      vi.mocked(mockStore.retireAllLeasesSparingPtys).mock.invocationCallOrder[0]!
    )
  })

  it('leaves leases alone when the same relay answers, tolerating RPC latency in the derived start', async () => {
    const { mockConn, mockStore, mockPortForward, getMainWindow } = createMockDeps()
    muxRequestMock.mockImplementation(relayStatus(4242, 60_000))
    vi.mocked(mockStore.getSshRelayIncarnation).mockReturnValue({
      targetId: 'target-1',
      pid: 4242,
      derivedStartAt: Date.now() - 60_000 - 5_000
    })

    const session = new SshRelaySession('target-1', getMainWindow, mockStore, mockPortForward)
    await session.establish(mockConn)

    expect(mockStore.retireAllLeasesSparingPtys).not.toHaveBeenCalled()
  })

  it('keeps leases when the token matches, however far the derived start has drifted', async () => {
    const { mockConn, mockStore, mockPortForward, getMainWindow } = createMockDeps()
    // An NTP step on either host moves `derivedStartAt` arbitrarily far. Without the token this is
    // exactly the reading that would retire every lease on a relay that never restarted.
    muxRequestMock.mockImplementation(relayStatus(4242, 60_000, 'tok-a'))
    vi.mocked(mockStore.getSshRelayIncarnation).mockReturnValue({
      targetId: 'target-1',
      pid: 4242,
      derivedStartAt: Date.now() - 9_000_000,
      token: 'tok-a'
    })

    const session = new SshRelaySession('target-1', getMainWindow, mockStore, mockPortForward)
    await session.establish(mockConn)

    expect(mockStore.retireAllLeasesSparingPtys).not.toHaveBeenCalled()
    expect(mockStore.setSshRelayIncarnation).toHaveBeenCalledWith(
      expect.objectContaining({ token: 'tok-a' })
    )
  })

  it('retires on a new token even when the pid was reused inside the start tolerance', async () => {
    const { mockConn, mockStore, mockPortForward, getMainWindow } = createMockDeps()
    muxRequestMock.mockImplementation(relayStatus(4242, 1_000, 'tok-b'))
    vi.mocked(mockStore.getSshRelayIncarnation).mockReturnValue({
      targetId: 'target-1',
      pid: 4242,
      derivedStartAt: Date.now() - 2_000,
      token: 'tok-a'
    })

    const session = new SshRelaySession('target-1', getMainWindow, mockStore, mockPortForward)
    await session.establish(mockConn)

    expect(mockStore.retireAllLeasesSparingPtys).toHaveBeenCalledWith(
      'target-1',
      expect.stringContaining('relay incarnation changed')
    )
  })

  it('falls back to pid and start time when the running relay predates the token', async () => {
    const { mockConn, mockStore, mockPortForward, getMainWindow } = createMockDeps()
    muxRequestMock.mockImplementation(relayStatus(4242, 60_000))
    // A stored token cannot decide against a reading that has none — that pairing means the deployed
    // relay is older than the token, not that the process changed.
    vi.mocked(mockStore.getSshRelayIncarnation).mockReturnValue({
      targetId: 'target-1',
      pid: 4242,
      derivedStartAt: Date.now() - 60_000 - 5_000,
      token: 'tok-a'
    })

    const session = new SshRelaySession('target-1', getMainWindow, mockStore, mockPortForward)
    await session.establish(mockConn)

    expect(mockStore.retireAllLeasesSparingPtys).not.toHaveBeenCalled()
    expect(mockStore.setSshRelayIncarnation).toHaveBeenCalledWith(
      expect.not.objectContaining({ token: expect.anything() })
    )
  })

  it('fails open when the relay cannot answer who it is', async () => {
    const { mockConn, mockStore, mockPortForward, getMainWindow } = createMockDeps()
    muxRequestMock.mockImplementation((method: string) =>
      method === 'relay.status' ? Promise.reject(new Error('unknown method')) : Promise.resolve([])
    )
    vi.mocked(mockStore.getSshRelayIncarnation).mockReturnValue({
      targetId: 'target-1',
      pid: 111,
      derivedStartAt: 1
    })

    const session = new SshRelaySession('target-1', getMainWindow, mockStore, mockPortForward)
    await session.establish(mockConn)

    expect(mockStore.retireAllLeasesSparingPtys).not.toHaveBeenCalled()
    expect(mockStore.setSshRelayIncarnation).not.toHaveBeenCalled()
  })

  it('records the first identity without retiring, so the reset before an upgrade is not charged to it', async () => {
    const { mockConn, mockStore, mockPortForward, getMainWindow } = createMockDeps()
    muxRequestMock.mockImplementation(relayStatus(4242, 1_000))
    vi.mocked(mockStore.getSshRelayIncarnation).mockReturnValue(null)

    const session = new SshRelaySession('target-1', getMainWindow, mockStore, mockPortForward)
    await session.establish(mockConn)

    expect(mockStore.setSshRelayIncarnation).toHaveBeenCalledOnce()
    expect(mockStore.retireAllLeasesSparingPtys).not.toHaveBeenCalled()
  })

  // D3/D7: a flag authorizes killing `pty-N` only in the incarnation that minted it. These three cases are
  // the ones where the id may since have been recycled onto a live pane, so the drain must not run at all.
  it.each([
    [
      'the relay incarnation changed',
      relayStatus(4242, 1_000, 'tok-b'),
      { targetId: 'target-1', pid: 111, derivedStartAt: Date.now() - 900_000, token: 'tok-a' }
    ],
    ['no previous incarnation was recorded', relayStatus(4242, 1_000, 'tok-b'), null],
    [
      'the relay could not say who it is',
      (method: string) =>
        method === 'relay.status'
          ? Promise.reject(new Error('unknown method'))
          : Promise.resolve([]),
      { targetId: 'target-1', pid: 4242, derivedStartAt: Date.now() - 60_000, token: 'tok-a' }
    ]
  ])('abandons pending reaps when %s', async (_case, statusImpl, previous) => {
    const { mockConn, mockStore, mockPortForward, getMainWindow } = createMockDeps()
    const { getSshPtyProvider } = await import('../ipc/pty')
    const mockShutdown = vi.fn().mockResolvedValue(undefined)
    vi.mocked(getSshPtyProvider).mockReturnValue({
      attachForReconnect: vi.fn().mockResolvedValue(undefined),
      shutdown: mockShutdown,
      hasPty: vi.fn().mockReturnValue(false),
      dispose: vi.fn()
    } as unknown as ReturnType<typeof getSshPtyProvider>)
    vi.mocked(getPtyIdsForConnection).mockReturnValue([])
    muxRequestMock.mockImplementation(statusImpl)
    vi.mocked(mockStore.getSshRelayIncarnation).mockReturnValue(previous)
    // A real store answers the claim out of the flags, so the fake must too — otherwise the drain would
    // reap from a queue that clearing had already emptied and the ordering here would prove nothing.
    const flagged = new Set(['pty-1'])
    vi.mocked(mockStore.claimSshRemotePtyLeasesToReap).mockImplementation(() => [...flagged])
    vi.mocked(mockStore.clearAllSshRemotePtyLeaseReapFlags).mockImplementation(() => {
      const cleared = flagged.size
      flagged.clear()
      return cleared
    })

    const session = new SshRelaySession('target-1', getMainWindow, mockStore, mockPortForward)
    await session.establish(mockConn)

    expect(mockStore.clearAllSshRemotePtyLeaseReapFlags).toHaveBeenCalledWith('target-1')
    expect(mockShutdown).not.toHaveBeenCalled()
  })
})
