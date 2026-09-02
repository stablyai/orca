import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = await vi.hoisted(async () => {
  const { createSshIpcMocks } = await import('./ssh-ipc-module-mocks')
  return createSshIpcMocks()
})

vi.mock('../ssh/ssh-config-host-picker', () => mocks.sshConfigHostPicker)
vi.mock('electron', () => mocks.electron)
vi.mock('./ssh-pty-output-intake-registry', () => mocks.sshPtyOutputIntakeRegistry)
vi.mock('../ssh/ssh-connection-store', () => mocks.sshConnectionStore)
vi.mock('../ssh/ssh-connection-manager', () => mocks.sshConnectionManager)
vi.mock('../ssh/ssh-relay-deploy', () => mocks.sshRelayDeploy)
vi.mock('../ssh/ssh-relay-reset', () => mocks.sshRelayReset)
vi.mock('../ssh/ssh-channel-multiplexer', () => mocks.sshChannelMultiplexer)
vi.mock('../providers/ssh-pty-provider', () => mocks.sshPtyProvider)
vi.mock('../providers/ssh-filesystem-provider', () => mocks.sshFilesystemProvider)
vi.mock('./pty', () => mocks.pty)
vi.mock('../providers/ssh-filesystem-dispatch', () => mocks.sshFilesystemDispatch)
vi.mock('../providers/ssh-git-provider', () => mocks.sshGitProvider)
vi.mock('../providers/ssh-git-dispatch', () => mocks.sshGitDispatch)
vi.mock('../ssh/ssh-port-forward', () => mocks.sshPortForward)
vi.mock('../ssh/ssh-port-scanner', () => mocks.sshPortScanner)

import { getActiveMultiplexer } from './ssh'
import {
  beginSshShutdown,
  SSH_SHUTDOWN_BUDGET_MS,
  type SshShutdownResult
} from './ssh-shutdown-drain'
import type { SshTarget } from '../../shared/ssh-types'
import { quitTeardownStartGate } from '../quit-teardown-start-gate'
import { createSshIpcHarness } from './ssh-ipc-test-harness'

const { mockSshStore, mockConnectionManager, mockMux, mockPortForwardManager } = mocks

describe('SSH IPC handlers', () => {
  const harness = createSshIpcHarness(mocks)
  const { handlers, mockStore, mockWindow } = harness

  beforeEach(harness.reset)

  it('detaches active SSH sessions during app shutdown without terminating recovery', async () => {
    const target: SshTarget = {
      id: 'ssh-1',
      label: 'Server',
      host: 'example.com',
      port: 22,
      username: 'deploy'
    }
    mockSshStore.getTarget.mockReturnValue(target)
    mockConnectionManager.connect.mockResolvedValue({})
    mockConnectionManager.getState.mockReturnValue({
      targetId: 'ssh-1',
      status: 'connected',
      error: null,
      reconnectAttempt: 0
    })
    await handlers.get('ssh:connect')!(null, { targetId: 'ssh-1' })
    mockMux.dispose.mockClear()
    mockConnectionManager.disconnectAll.mockClear().mockResolvedValue(undefined)

    await beginSshShutdown()

    expect(mockPortForwardManager.removeAllForwards).toHaveBeenCalledWith('ssh-1')
    expect(mockMux.dispose).toHaveBeenCalledWith('connection_lost')
    expect(mockStore.markSshRemotePtyLeasesAsync).toHaveBeenCalledWith('ssh-1', 'detached')
    expect(mockStore.removeSshPtyConsumerRecovery).not.toHaveBeenCalled()
    expect(mockConnectionManager.disconnectAll).toHaveBeenCalled()
  })

  it('detaches every lease in memory before a slow forward removal can cross the final flush', async () => {
    const target: SshTarget = {
      id: 'ssh-1',
      label: 'Server',
      host: 'example.com',
      port: 22,
      username: 'deploy'
    }
    mockSshStore.getTarget.mockReturnValue(target)
    mockConnectionManager.connect.mockResolvedValue({})
    mockConnectionManager.getState.mockReturnValue({
      targetId: 'ssh-1',
      status: 'connected',
      error: null,
      reconnectAttempt: 0
    })
    await handlers.get('ssh:connect')!(null, { targetId: 'ssh-1' })
    mockConnectionManager.disconnectAll.mockClear().mockResolvedValue(undefined)
    let releaseForwards!: () => void
    vi.mocked(mockPortForwardManager.removeAllForwards).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseForwards = resolve
        })
    )
    vi.mocked(mockStore.markSshRemotePtyLeasesForShutdown).mockClear()
    quitTeardownStartGate.tryStart({ preventDefault() {} })

    const shutdown = beginSshShutdown()

    // Why asserted with no await: the committed quit path calls store.flushAsync() on the very next
    // line, so anything not already in memory at this instant can never reach the final snapshot.
    expect(mockStore.markSshRemotePtyLeasesForShutdown).toHaveBeenCalledWith('ssh-1', 'detached')
    // Why 'detached' and never 'terminated': the app is letting go of the lease, not proving the
    // remote shell died. Those PTYs keep running for the next attach.
    expect(mockStore.markSshRemotePtyLeasesForShutdown).not.toHaveBeenCalledWith(
      'ssh-1',
      'terminated'
    )
    expect(mockStore.removeSshPtyConsumerRecovery).not.toHaveBeenCalled()
    expect(mockPortForwardManager.removeAllForwards).toHaveBeenCalledWith('ssh-1')

    releaseForwards()
    await shutdown
  })

  it('repeats no state transition when shutdown is begun twice', async () => {
    const target: SshTarget = {
      id: 'ssh-1',
      label: 'Server',
      host: 'example.com',
      port: 22,
      username: 'deploy'
    }
    mockSshStore.getTarget.mockReturnValue(target)
    mockConnectionManager.connect.mockResolvedValue({})
    mockConnectionManager.getState.mockReturnValue({
      targetId: 'ssh-1',
      status: 'connected',
      error: null,
      reconnectAttempt: 0
    })
    await handlers.get('ssh:connect')!(null, { targetId: 'ssh-1' })
    mockConnectionManager.disconnectAll.mockClear().mockResolvedValue(undefined)
    vi.mocked(mockStore.markSshRemotePtyLeasesForShutdown).mockClear()
    quitTeardownStartGate.tryStart({ preventDefault() {} })

    const first = beginSshShutdown()
    const second = beginSshShutdown()

    expect(second).toBe(first)
    await Promise.all([first, second])
    expect(mockStore.markSshRemotePtyLeasesForShutdown).toHaveBeenCalledExactlyOnceWith(
      'ssh-1',
      'detached'
    )
  })

  it('detaches the remaining sessions and still returns when one session throws mid-transition', async () => {
    const targets: Record<string, SshTarget> = {
      'ssh-1': { id: 'ssh-1', label: 'A', host: 'a.example.com', port: 22, username: 'deploy' },
      'ssh-2': { id: 'ssh-2', label: 'B', host: 'b.example.com', port: 22, username: 'deploy' }
    }
    mockSshStore.getTarget.mockImplementation((id: string) => targets[id] ?? null)
    mockConnectionManager.connect.mockResolvedValue({})
    mockConnectionManager.getState.mockImplementation((targetId: string) => ({
      targetId,
      status: 'connected',
      error: null,
      reconnectAttempt: 0
    }))
    await handlers.get('ssh:connect')!(null, { targetId: 'ssh-1' })
    await handlers.get('ssh:connect')!(null, { targetId: 'ssh-2' })
    mockConnectionManager.disconnectAll.mockClear().mockResolvedValue(undefined)
    vi.mocked(mockStore.markSshRemotePtyLeasesForShutdown).mockClear()
    // Why webContents.send: quit destroys the renderer, and that is what makes broadcastEmptyLists
    // throw out of the pre-pass for whichever session reaches it first.
    mockWindow.webContents.send.mockImplementation((_channel: string, payload: unknown) => {
      if ((payload as { targetId?: string } | undefined)?.targetId === 'ssh-1') {
        throw new Error('Object has been destroyed')
      }
    })
    quitTeardownStartGate.tryStart({ preventDefault() {} })

    // Why not-throw rather than a resolved promise: the caller is a non-async will-quit listener, so
    // a synchronous throw escapes it and skips killAllPty, the watchers and store.flushAsync() — the
    // very flush that persists the detached leases this pre-pass just staged.
    let shutdown!: Promise<SshShutdownResult>
    expect(() => {
      shutdown = beginSshShutdown()
    }).not.toThrow()
    // Why asserted before the await: the real flush starts on the next synchronous line.
    expect(mockStore.markSshRemotePtyLeasesForShutdown).toHaveBeenCalledWith('ssh-2', 'detached')

    const result = await shutdown
    expect(
      result.errors.some(
        (error) => error instanceof Error && error.message === 'Object has been destroyed'
      )
    ).toBe(true)
  })

  it('reports the target and phase left unfinished when the shutdown budget expires', async () => {
    vi.useFakeTimers()
    try {
      const target: SshTarget = {
        id: 'ssh-1',
        label: 'Server',
        host: 'example.com',
        port: 22,
        username: 'deploy'
      }
      mockSshStore.getTarget.mockReturnValue(target)
      mockConnectionManager.connect.mockResolvedValue({})
      mockConnectionManager.getState.mockReturnValue({
        targetId: 'ssh-1',
        status: 'connected',
        error: null,
        reconnectAttempt: 0
      })
      await handlers.get('ssh:connect')!(null, { targetId: 'ssh-1' })
      mockConnectionManager.disconnectAll.mockClear().mockResolvedValue(undefined)
      // Why never resolved, on every call: a forward whose child never reports exit is exactly the
      // case the shared deadline exists for, and it must not get a fresh budget per phase.
      vi.mocked(mockPortForwardManager.removeAllForwards).mockImplementation(
        () => new Promise(() => {})
      )
      quitTeardownStartGate.tryStart({ preventDefault() {} })

      let settled = false
      const shutdown = beginSshShutdown().then((value) => {
        settled = true
        return value
      })
      // Why the whole budget and not a millisecond more: the entire drain/join/drain sequence has to
      // fit inside one deadline, so advancing exactly that far must be enough to settle it. Asserting
      // the flag rather than awaiting keeps a per-phase budget a failure instead of a hang.
      await vi.advanceTimersByTimeAsync(SSH_SHUTDOWN_BUDGET_MS)
      expect(settled).toBe(true)
      const result = await shutdown

      expect(result.unfinished).toContainEqual({ targetId: 'ssh-1', phase: 'drain' })
      // Why no final-drain entry: the budget was already spent, so no later phase was awaited at all.
      expect(result.unfinished.some((entry) => entry.phase === 'final-drain')).toBe(false)
      // Why the lease still stands: the drain timing out says nothing about the remote PTYs, and the
      // pre-pass already recorded the only thing that was ever provable.
      expect(mockStore.markSshRemotePtyLeasesForShutdown).toHaveBeenCalledWith('ssh-1', 'detached')
      expect(mockStore.removeSshPtyConsumerRecovery).not.toHaveBeenCalled()
    } finally {
      vi.mocked(mockPortForwardManager.removeAllForwards).mockReset().mockResolvedValue(undefined)
      vi.useRealTimers()
    }
  })

  it('returns as soon as a fast shutdown drains rather than waiting out the budget', async () => {
    vi.useFakeTimers()
    try {
      mockConnectionManager.disconnectAll.mockClear().mockResolvedValue(undefined)
      quitTeardownStartGate.tryStart({ preventDefault() {} })

      const result = await beginSshShutdown()

      expect(result.unfinished).toEqual([])
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('refuses the replacement session a paused connect would publish after shutdown began', async () => {
    const target: SshTarget = {
      id: 'ssh-1',
      label: 'Server',
      host: 'example.com',
      port: 22,
      username: 'deploy'
    }
    mockSshStore.getTarget.mockReturnValue(target)
    mockConnectionManager.connect.mockResolvedValue({})
    mockConnectionManager.getState.mockReturnValue({
      targetId: 'ssh-1',
      status: 'connected',
      error: null,
      reconnectAttempt: 0
    })
    mockConnectionManager.disconnectAll.mockResolvedValue(undefined)
    await handlers.get('ssh:connect')!(null, { targetId: 'ssh-1' })

    // Why here: the old session's lease flush is the one window where doConnect resumes straight into
    // publishing its replacement session without re-checking authority.
    let releaseDetach = (): void => {}
    const detachFlush = new Promise<void>((resolve) => {
      releaseDetach = resolve
    })
    let signalEnteredDetach = (): void => {}
    const enteredDetach = new Promise<void>((resolve) => {
      signalEnteredDetach = resolve
    })
    mockStore.markSshRemotePtyLeasesAsync.mockImplementationOnce(() => {
      signalEnteredDetach()
      return detachFlush
    })

    const replacement = handlers.get('ssh:connect')!(null, { targetId: 'ssh-1' })
    // Why await the flush entry and not ticks: shutdown must not snapshot what to drain until the
    // replacement connect is parked in the lease flush.
    await enteredDetach
    expect(mockStore.markSshRemotePtyLeasesAsync).toHaveBeenCalledWith('ssh-1', 'detached')

    mockConnectionManager.disconnectAll.mockClear()
    // Why latch the gate here: the committed quit path owns it, so the drain alone must not fence.
    quitTeardownStartGate.tryStart({ preventDefault() {} })
    const shutdown = beginSshShutdown()
    releaseDetach()

    await expect(replacement).rejects.toThrow('closed for app shutdown')
    await shutdown

    // Why one detach: the fence sits at the publication point, so the resumed connect never registers a
    // replacement session — only the old session it had already torn down was detached.
    const detaches = mockStore.markSshRemotePtyLeasesAsync.mock.calls.filter(
      (call) => call[1] === 'detached'
    )
    expect(detaches).toHaveLength(1)
    // Why twice: once for the drain's snapshot, once after joining the connect that was still in flight.
    expect(mockConnectionManager.disconnectAll).toHaveBeenCalledTimes(2)
    expect(getActiveMultiplexer('ssh-1')).toBeUndefined()
    await expect(handlers.get('ssh:connect')!(null, { targetId: 'ssh-1' })).rejects.toThrow(
      'closed for app shutdown'
    )
  })

  it('joins an in-flight test-connection probe before the final shutdown disconnect', async () => {
    const target: SshTarget = {
      id: 'ssh-probe',
      label: 'Server',
      host: 'example.com',
      port: 22,
      username: 'deploy'
    }
    mockSshStore.getTarget.mockReturnValue(target)
    mockConnectionManager.getState.mockReturnValue({
      targetId: 'ssh-probe',
      status: 'connected',
      error: null,
      reconnectAttempt: 0
    })
    mockConnectionManager.disconnectAll.mockResolvedValue(undefined)
    mockConnectionManager.disconnect.mockClear().mockResolvedValue(undefined)

    // Why: a probe holds a transport no session owns, so shutdown has to wait for it to hand it back.
    const probeState = {
      targetId: 'ssh-probe',
      status: 'connected',
      error: null,
      reconnectAttempt: 0
    }
    let openProbeTransport = (): void => {}
    mockConnectionManager.connect.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          openProbeTransport = () => resolve({ getState: () => probeState })
        })
    )
    const probe = handlers.get('ssh:testConnection')!(null, { targetId: 'ssh-probe' })
    for (let tick = 0; tick < 5; tick++) {
      await Promise.resolve()
    }
    expect(mockConnectionManager.connect).toHaveBeenCalledWith(target)

    quitTeardownStartGate.tryStart({ preventDefault() {} })
    const shutdown = beginSshShutdown()
    openProbeTransport()
    await shutdown

    expect(await probe).toMatchObject({ success: true })
    expect(mockConnectionManager.disconnect).toHaveBeenCalledWith('ssh-probe')
  })
})
