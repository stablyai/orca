import { beforeEach, describe, expect, it, vi } from 'vitest'

const { listRegisteredPtysMock } = vi.hoisted(() => ({
  listRegisteredPtysMock: vi.fn()
}))

vi.mock('../memory/pty-registry', () => ({
  listRegisteredPtys: listRegisteredPtysMock
}))

import { killAllProcessesForWorktree, WORKTREE_PROCESS_SWEEP_TIMEOUT_MS } from './worktree-teardown'
import type { IPtyProvider, PtyProcessInfo } from '../providers/types'
import { DaemonPtyAdapter } from '../daemon/daemon-pty-adapter'

function createProviderStub(listProcesses: () => Promise<PtyProcessInfo[]>): IPtyProvider {
  return {
    spawn: vi.fn(),
    attach: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    shutdown: vi.fn().mockResolvedValue(undefined),
    sendSignal: vi.fn(),
    getCwd: vi.fn(),
    getInitialCwd: vi.fn(),
    clearBuffer: vi.fn(),
    acknowledgeDataEvent: vi.fn(),
    hasChildProcesses: vi.fn(),
    getForegroundProcess: vi.fn(),
    serialize: vi.fn(),
    revive: vi.fn(),
    listProcesses: vi.fn(listProcesses),
    getDefaultShell: vi.fn(),
    getProfiles: vi.fn(),
    onData: vi.fn().mockReturnValue(() => {}),
    onReplay: vi.fn().mockReturnValue(() => {}),
    onExit: vi.fn().mockReturnValue(() => {})
  } as unknown as IPtyProvider
}

describe('killAllProcessesForWorktree', () => {
  beforeEach(() => {
    listRegisteredPtysMock.mockReset()
  })

  it('reaches daemon sessions and registry entries without a runtime', async () => {
    // Simulate headless-CLI: no renderer, so `runtime` is undefined.
    const localProvider = createProviderStub(async () => [
      { id: 'w1@@abcd1234', cwd: '/tmp/w1', title: 'shell' },
      { id: 'w2@@efef5678', cwd: '/tmp/w2', title: 'shell' }
    ])
    listRegisteredPtysMock.mockReturnValue([
      { ptyId: 'w1-registry-1', worktreeId: 'w1', sessionId: null, paneKey: null, pid: 100 },
      { ptyId: 'w2-registry-2', worktreeId: 'w2', sessionId: null, paneKey: null, pid: 101 }
    ])
    const onPtyStopped = vi.fn()

    const result = await killAllProcessesForWorktree('w1', { localProvider, onPtyStopped })

    expect(result.runtimeStopped).toBe(0)
    expect(result.providerStopped).toBe(1)
    expect(result.registryStopped).toBe(1)

    expect(localProvider.shutdown).toHaveBeenCalledWith(
      'w1@@abcd1234',
      expect.objectContaining({ immediate: true })
    )
    expect(localProvider.shutdown).toHaveBeenCalledWith(
      'w1-registry-1',
      expect.objectContaining({ immediate: true })
    )
    expect(localProvider.shutdown).not.toHaveBeenCalledWith(
      'w2@@efef5678',
      expect.objectContaining({ immediate: true })
    )
    expect(localProvider.shutdown).not.toHaveBeenCalledWith(
      'w2-registry-2',
      expect.objectContaining({ immediate: true })
    )
    expect(onPtyStopped).toHaveBeenCalledWith('w1@@abcd1234')
    expect(onPtyStopped).toHaveBeenCalledWith('w1-registry-1')
    expect(onPtyStopped).not.toHaveBeenCalledWith('w2@@efef5678')
    expect(onPtyStopped).not.toHaveBeenCalledWith('w2-registry-2')
  })

  it('skips the daemon prefix sweep safely when the provider uses numeric ids', async () => {
    // LocalPtyProvider shape: numeric ids that cannot match `${worktreeId}@@`.
    const localProvider = createProviderStub(async () => [
      { id: '1', cwd: '/tmp/w1', title: 'shell' },
      { id: '2', cwd: '/tmp/w2', title: 'shell' }
    ])
    listRegisteredPtysMock.mockReturnValue([
      { ptyId: '1', worktreeId: 'w1', sessionId: null, paneKey: null, pid: 200 }
    ])
    const onPtyStopped = vi.fn()

    const result = await killAllProcessesForWorktree('w1', { localProvider, onPtyStopped })

    // Prefix sweep must kill nothing; registry sweep must still fire.
    expect(result.providerStopped).toBe(0)
    expect(result.registryStopped).toBe(1)
    expect(localProvider.shutdown).toHaveBeenCalledWith(
      '1',
      expect.objectContaining({ immediate: true })
    )
    expect(localProvider.shutdown).toHaveBeenCalledTimes(1)
    expect(onPtyStopped).toHaveBeenCalledWith('1')
  })

  it('stops cwd-owned PTYs even when their ids have no worktree prefix', async () => {
    const localProvider = createProviderStub(async () => [
      { id: 'floating-1', cwd: '/repo/app/nested', title: 'shell' },
      { id: 'outside-2', cwd: '/repo/application', title: 'shell' },
      { id: 'repo-1::/repo/app@@legacy-3', title: 'shell' } as PtyProcessInfo
    ])
    listRegisteredPtysMock.mockReturnValue([])

    const result = await killAllProcessesForWorktree('repo-1::/repo/app', {
      localProvider,
      requirePhysicalStop: true
    })

    expect(localProvider.shutdown).toHaveBeenCalledWith(
      'floating-1',
      expect.objectContaining({ immediate: true })
    )
    expect(localProvider.shutdown).toHaveBeenCalledWith(
      'repo-1::/repo/app@@legacy-3',
      expect.objectContaining({ immediate: true })
    )
    expect(localProvider.shutdown).not.toHaveBeenCalledWith(
      'outside-2',
      expect.objectContaining({ immediate: true })
    )
    expect(result.providerStopped).toBe(2)
  })

  it('does not use cwd fallback against a different authoritative worktree id', async () => {
    const localProvider = createProviderStub(async () => [
      {
        id: 'owned-by-sibling',
        cwd: '/repo/app/nested',
        title: 'shell',
        worktreeId: 'repo-1::/repo/sibling'
      }
    ])
    listRegisteredPtysMock.mockReturnValue([])

    const result = await killAllProcessesForWorktree('repo-1::/repo/app', {
      localProvider,
      requirePhysicalStop: true
    })

    expect(localProvider.shutdown).not.toHaveBeenCalled()
    expect(result.providerStopped).toBe(0)
  })

  it('uses authoritative remote worktree ownership without sweeping the local registry', async () => {
    const remoteProvider = createProviderStub(async () => [
      { id: 'pty-remote', cwd: '/remote/w1', title: 'shell', worktreeId: 'w1' },
      { id: 'pty-sibling', cwd: '/remote/w2', title: 'shell', worktreeId: 'w2' }
    ])
    listRegisteredPtysMock.mockReturnValue([
      { ptyId: 'local-1', worktreeId: 'w1', sessionId: null, paneKey: null, pid: 200 }
    ])

    const result = await killAllProcessesForWorktree('w1', {
      localProvider: remoteProvider,
      includeLocalRegistry: false,
      requirePhysicalStop: true
    })

    expect(remoteProvider.shutdown).toHaveBeenCalledWith(
      'pty-remote',
      expect.objectContaining({ immediate: true })
    )
    expect(remoteProvider.shutdown).not.toHaveBeenCalledWith(
      'pty-sibling',
      expect.objectContaining({ immediate: true })
    )
    expect(remoteProvider.shutdown).not.toHaveBeenCalledWith(
      'local-1',
      expect.objectContaining({ immediate: true })
    )
    expect(listRegisteredPtysMock).not.toHaveBeenCalled()
    expect(result).toEqual({ runtimeStopped: 0, providerStopped: 1, registryStopped: 0 })
  })

  it('best-effort: swallows errors from listProcesses and shutdown', async () => {
    const localProvider = createProviderStub(() => Promise.reject(new Error('boom')))
    listRegisteredPtysMock.mockReturnValue([
      { ptyId: 'x', worktreeId: 'w1', sessionId: null, paneKey: null, pid: 10 }
    ])
    ;(localProvider.shutdown as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('already dead')
    )

    const result = await killAllProcessesForWorktree('w1', { localProvider })

    // listProcesses rejected → provider sweep returns 0; registry shutdown
    // rejected → counted as not-killed (registry sweep currently swallows).
    expect(result.providerStopped).toBe(0)
    expect(result.registryStopped).toBe(0)
  })

  it('does not let cleanup hook failures abort teardown', async () => {
    const localProvider = createProviderStub(async () => [
      { id: 'w1@@aaaa', cwd: '/tmp/w1', title: 'shell' }
    ])
    listRegisteredPtysMock.mockReturnValue([])
    const onPtyStopped = vi.fn(() => {
      throw new Error('cleanup failed')
    })

    const result = await killAllProcessesForWorktree('w1', { localProvider, onPtyStopped })

    expect(result.providerStopped).toBe(1)
    expect(onPtyStopped).toHaveBeenCalledWith('w1@@aaaa')
  })

  it('does not carry state between successive calls with distinct providers', async () => {
    // Guards against a future refactor that memoises provider or registry
    // reads inside the helper.
    const providerA = createProviderStub(async () => [
      { id: 'w1@@aaaa', cwd: '/tmp', title: 'shell' }
    ])
    const providerB = createProviderStub(async () => [
      { id: 'w1@@bbbb', cwd: '/tmp', title: 'shell' }
    ])
    listRegisteredPtysMock.mockReturnValue([])

    const r1 = await killAllProcessesForWorktree('w1', { localProvider: providerA })
    expect(providerA.shutdown).toHaveBeenCalledWith(
      'w1@@aaaa',
      expect.objectContaining({ immediate: true })
    )
    expect(providerB.shutdown).not.toHaveBeenCalled()
    expect(r1.providerStopped).toBe(1)

    const r2 = await killAllProcessesForWorktree('w1', { localProvider: providerB })
    expect(providerB.shutdown).toHaveBeenCalledWith(
      'w1@@bbbb',
      expect.objectContaining({ immediate: true })
    )
    expect(providerB.shutdown).toHaveBeenCalledTimes(1)
    expect(r2.providerStopped).toBe(1)
  })

  it('starts owned provider shutdowns together so agent snapshots can coalesce', async () => {
    const localProvider = createProviderStub(async () => [
      { id: 'w1@@aaaa', cwd: '/tmp', title: 'shell' },
      { id: 'w1@@bbbb', cwd: '/tmp', title: 'shell' }
    ])
    listRegisteredPtysMock.mockReturnValue([])
    const releases: (() => void)[] = []
    ;(localProvider.shutdown as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releases.push(resolve)
        })
    )

    const teardown = killAllProcessesForWorktree('w1', { localProvider })
    await vi.waitFor(() => expect(localProvider.shutdown).toHaveBeenCalledTimes(2))
    expect(releases).toHaveLength(2)

    for (const release of releases) {
      release()
    }
    await expect(teardown).resolves.toEqual({
      runtimeStopped: 0,
      providerStopped: 2,
      registryStopped: 0
    })
  })

  it('bounds provider shutdown fanout while preserving concurrent batches', async () => {
    const sessions = Array.from({ length: 40 }, (_, index) => ({
      id: `w1@@${index}`,
      cwd: '/tmp',
      title: 'shell'
    }))
    const localProvider = createProviderStub(async () => sessions)
    listRegisteredPtysMock.mockReturnValue([])
    let active = 0
    let maxActive = 0
    const releases: (() => void)[] = []
    ;(localProvider.shutdown as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          active += 1
          maxActive = Math.max(maxActive, active)
          releases.push(() => {
            active -= 1
            resolve()
          })
        })
    )

    const teardown = killAllProcessesForWorktree('w1', { localProvider })
    await vi.waitFor(() => expect(localProvider.shutdown).toHaveBeenCalledTimes(32))
    expect(maxActive).toBe(32)
    releases.splice(0).forEach((release) => release())
    await vi.waitFor(() => expect(localProvider.shutdown).toHaveBeenCalledTimes(40))
    releases.splice(0).forEach((release) => release())

    await expect(teardown).resolves.toEqual({
      runtimeStopped: 0,
      providerStopped: 40,
      registryStopped: 0
    })
  })

  it('invokes runtime.stopTerminalsForWorktree when runtime is provided', async () => {
    const stopTerminalsForWorktree = vi.fn().mockResolvedValue({ stopped: 3 })
    const runtime = {
      stopTerminalsForWorktree
    } as unknown as Parameters<typeof killAllProcessesForWorktree>[1]['runtime']

    const localProvider = createProviderStub(async () => [])
    listRegisteredPtysMock.mockReturnValue([])

    const result = await killAllProcessesForWorktree('w1', { runtime, localProvider })

    expect(stopTerminalsForWorktree).toHaveBeenCalledWith('w1', {
      deadline: expect.any(Number),
      stopPty: expect.any(Function)
    })
    expect(result.runtimeStopped).toBe(3)
  })

  it('claims duplicate provider and registry PTY ids only once', async () => {
    const localProvider = createProviderStub(async () => [
      { id: 'w1@@same', cwd: '/tmp/w1', title: 'shell' }
    ])
    listRegisteredPtysMock.mockReturnValue([
      { ptyId: 'w1@@same', worktreeId: 'w1', sessionId: null, paneKey: null, pid: 100 }
    ])

    const result = await killAllProcessesForWorktree('w1', { localProvider })

    expect(localProvider.shutdown).toHaveBeenCalledTimes(1)
    expect(localProvider.shutdown).toHaveBeenCalledWith(
      'w1@@same',
      expect.objectContaining({ immediate: true })
    )
    expect(result.providerStopped + result.registryStopped).toBe(1)
  })

  it('falls back to provider shutdown when the runtime cannot stop an overlapping PTY', async () => {
    const stopTerminalsForWorktree = vi.fn(
      async (
        _worktreeId: string,
        options: {
          stopPty: (
            ptyId: string,
            stop: () => boolean
          ) => Promise<{ stopped: boolean; owner: boolean }>
        }
      ) => ({
        stopped: (await options.stopPty('w1@@same', () => false)).owner ? 1 : 0
      })
    )
    const runtime = {
      stopTerminalsForWorktree
    } as unknown as Parameters<typeof killAllProcessesForWorktree>[1]['runtime']
    const localProvider = createProviderStub(async () => [])
    listRegisteredPtysMock.mockReturnValue([
      { ptyId: 'w1@@same', worktreeId: 'w1', sessionId: null, paneKey: null, pid: 100 }
    ])

    const result = await killAllProcessesForWorktree('w1', { runtime, localProvider })

    expect(result.runtimeStopped).toBe(0)
    expect(result.registryStopped).toBe(1)
    expect(localProvider.shutdown).toHaveBeenCalledTimes(1)
  })

  it('accepts a failed Windows stop when a fresh inventory proves the PTY exited', async () => {
    const worktreeId = 'repo-1::C:/Users/User/orca/workspaces/repo/feature'
    const ptyId = `${worktreeId}@@windows-pty`
    const stopTerminalsForWorktree = vi.fn(
      async (
        _worktreeId: string,
        options: {
          stopPty: (
            ptyId: string,
            stop: () => boolean
          ) => Promise<{ stopped: boolean; owner: boolean }>
        }
      ) => ({
        stopped: (await options.stopPty(ptyId, () => false)).owner ? 1 : 0
      })
    )
    const runtime = {
      stopTerminalsForWorktree
    } as unknown as Parameters<typeof killAllProcessesForWorktree>[1]['runtime']
    let inventoryCount = 0
    const localProvider = createProviderStub(async () => {
      inventoryCount += 1
      return inventoryCount === 1
        ? [{ id: ptyId, cwd: 'C:/Users/User/orca/workspaces/repo/feature', title: 'shell' }]
        : []
    })
    ;(localProvider.shutdown as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error(`Session not found: ${ptyId}`)
    )
    listRegisteredPtysMock.mockReturnValue([
      { ptyId, worktreeId, sessionId: null, paneKey: null, pid: 100 }
    ])

    await expect(
      killAllProcessesForWorktree(worktreeId, {
        runtime,
        localProvider,
        requirePhysicalStop: true
      })
    ).resolves.toEqual({
      runtimeStopped: 0,
      providerStopped: 0,
      registryStopped: 0
    })
    expect(localProvider.listProcesses).toHaveBeenCalledTimes(2)
  })

  it('keeps duplicate sweeps behind the runtime physical-stop promise', async () => {
    let releasePhysicalStop: () => void = () => undefined
    const physicalStop = new Promise<boolean>((resolve) => {
      releasePhysicalStop = () => resolve(true)
    })
    const stopTerminalsForWorktree = vi.fn(
      async (
        _worktreeId: string,
        options: {
          stopPty: (
            ptyId: string,
            stop: () => Promise<boolean>
          ) => Promise<{ stopped: boolean; owner: boolean }>
        }
      ) => ({
        stopped: (await options.stopPty('w1@@same', () => physicalStop)).owner ? 1 : 0
      })
    )
    const runtime = {
      stopTerminalsForWorktree
    } as unknown as Parameters<typeof killAllProcessesForWorktree>[1]['runtime']
    const localProvider = createProviderStub(async () => [
      { id: 'w1@@same', cwd: '/tmp/w1', title: 'shell' }
    ])
    listRegisteredPtysMock.mockReturnValue([
      { ptyId: 'w1@@same', worktreeId: 'w1', sessionId: null, paneKey: null, pid: 100 }
    ])

    const teardown = killAllProcessesForWorktree('w1', { runtime, localProvider })
    await vi.waitFor(() => expect(stopTerminalsForWorktree).toHaveBeenCalledTimes(1))
    expect(localProvider.shutdown).not.toHaveBeenCalled()

    releasePhysicalStop()
    await expect(teardown).resolves.toEqual({
      runtimeStopped: 1,
      providerStopped: 0,
      registryStopped: 0
    })
    expect(localProvider.shutdown).not.toHaveBeenCalled()
  })

  it('fails destructive teardown closed when physical stop misses the deadline', async () => {
    vi.useFakeTimers()
    try {
      const physicalStop = new Promise<boolean>(() => {})
      const stopTerminalsForWorktree = vi.fn(
        async (
          _worktreeId: string,
          options: {
            stopPty: (
              ptyId: string,
              stop: () => Promise<boolean>
            ) => Promise<{ stopped: boolean; owner: boolean }>
          }
        ) => ({
          stopped: (await options.stopPty('w1@@same', () => physicalStop)).owner ? 1 : 0
        })
      )
      const runtime = {
        stopTerminalsForWorktree
      } as unknown as Parameters<typeof killAllProcessesForWorktree>[1]['runtime']
      const localProvider = createProviderStub(async () => [
        { id: 'w1@@same', cwd: '/tmp/w1', title: 'shell' }
      ])
      listRegisteredPtysMock.mockReturnValue([
        { ptyId: 'w1@@same', worktreeId: 'w1', sessionId: null, paneKey: null, pid: 100 }
      ])

      const teardown = killAllProcessesForWorktree('w1', {
        runtime,
        localProvider,
        timeoutMs: 25,
        requirePhysicalStop: true
      })
      const failure = expect(teardown).rejects.toThrow(
        'Timed out waiting for physical PTY teardown'
      )
      await vi.advanceTimersByTimeAsync(24)
      expect(localProvider.shutdown).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)

      await failure
      expect(localProvider.shutdown).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  // Why: on win32 the DaemonPtyAdapter is the local provider, so an unbounded
  // kill RPC (30s default > the 10s sweep deadline) let the outer deadline win
  // with the confusing "Timed out waiting for physical PTY teardown" instead of
  // the accurate stop failure. The bound must fire first (native-Windows regression).
  it('destructive teardown surfaces a bounded stop failure when the daemon kill RPC never replies (#9500 regression)', async () => {
    vi.useFakeTimers()
    try {
      const worktreeId = 'w1'
      const sessionId = 'w1@@dead0001'
      let killRequests = 0

      // A fake daemon RPC client standing in for a wedged daemon: it answers
      // listSessions (so the session is discovered as owned) but never sends a
      // reply to 'kill'. It faithfully models the real DaemonClient.request
      // contract — a request is only bounded by its own timeoutMs, which
      // defaults to REQUEST_TIMEOUT_MS (30_000). The adapter's shutdown passes
      // no override, so the kill can only settle after 30s: long past the 10s
      // sweep deadline.
      const DAEMON_DEFAULT_REQUEST_TIMEOUT_MS = 30_000
      const fakeClient = {
        onDisconnected: () => () => {},
        onEvent: () => () => {},
        ensureConnected: async () => {},
        // Why: bounded teardown connects via ensureConnectedWithin; model the real
        // DaemonClient method so the shared connect+RPC budget path is exercised.
        ensureConnectedWithin: async () => {},
        isConnected: () => true,
        disconnect: () => {},
        notify: () => {},
        request: (
          type: string,
          _payload?: unknown,
          timeoutMs = DAEMON_DEFAULT_REQUEST_TIMEOUT_MS
        ): Promise<unknown> => {
          if (type === 'listSessions') {
            return Promise.resolve({
              sessions: [{ sessionId, isAlive: true, cwd: '/tmp/w1' }]
            })
          }
          if (type === 'kill') {
            killRequests += 1
            // The daemon never replies; the request only rejects when its own
            // timeout elapses, exactly like the real client.
            return new Promise((_resolve, reject) => {
              setTimeout(
                () => reject(new Error(`Request kill timed out after ${timeoutMs}ms`)),
                timeoutMs
              )
            })
          }
          return Promise.resolve({})
        }
      }

      const adapter = new DaemonPtyAdapter({ socketPath: '/tmp/sock', tokenPath: '/tmp/tok' })
      ;(adapter as unknown as { client: typeof fakeClient }).client = fakeClient

      listRegisteredPtysMock.mockReturnValue([])

      // Capture the rejection as a value so a wrong error is a clean assertion
      // failure below rather than a floating unhandled rejection while fake
      // timers fire.
      const outcome = killAllProcessesForWorktree(worktreeId, {
        localProvider: adapter as unknown as IPtyProvider,
        includeLocalRegistry: false,
        requirePhysicalStop: true,
        timeoutMs: WORKTREE_PROCESS_SWEEP_TIMEOUT_MS
      }).then(
        () => {
          throw new Error('teardown unexpectedly resolved')
        },
        (error: Error) => error
      )

      // Advance past the daemon's 8s physical-exit budget AND the 10s sweep
      // deadline. A bounded adapter shutdown would have rejected inside this
      // window, letting the sweep report a clean stop failure. Today nothing
      // settles before the deadline, so the sweep throws its deadline error.
      await vi.advanceTimersByTimeAsync(WORKTREE_PROCESS_SWEEP_TIMEOUT_MS)

      const error = await outcome
      expect(killRequests).toBeGreaterThan(0)
      // Why: the adapter bounds its kill RPC below the sweep deadline, so a wedged
      // daemon yields the accurate stop failure — not the confusing deadline error.
      expect(error.message).toContain('Failed to physically stop every PTY')
    } finally {
      vi.useRealTimers()
    }
  })

  it('tolerates runtime.stopTerminalsForWorktree throwing (headless assertGraphReady reject)', async () => {
    const stopTerminalsForWorktree = vi.fn().mockRejectedValue(new Error('runtime_unavailable'))
    const runtime = {
      stopTerminalsForWorktree
    } as unknown as Parameters<typeof killAllProcessesForWorktree>[1]['runtime']

    const localProvider = createProviderStub(async () => [])
    listRegisteredPtysMock.mockReturnValue([])

    const result = await killAllProcessesForWorktree('w1', { runtime, localProvider })

    expect(result.runtimeStopped).toBe(0)
  })

  it('tolerates an unresolved runtime selector during destructive removal', async () => {
    // Why: a just-created/removed worktree can be absent from the runtime
    // graph; that means zero runtime-owned PTYs, not a failed teardown.
    const stopTerminalsForWorktree = vi.fn().mockRejectedValue(new Error('selector_not_found'))
    const runtime = {
      stopTerminalsForWorktree
    } as unknown as Parameters<typeof killAllProcessesForWorktree>[1]['runtime']
    const localProvider = createProviderStub(async () => [])
    listRegisteredPtysMock.mockReturnValue([])

    const result = await killAllProcessesForWorktree('w1', {
      runtime,
      localProvider,
      requirePhysicalStop: true
    })

    expect(result.runtimeStopped).toBe(0)
  })

  it('fails destructive teardown closed when the runtime sweep rejects', async () => {
    const stopTerminalsForWorktree = vi.fn().mockRejectedValue(new Error('runtime sweep failed'))
    const runtime = {
      stopTerminalsForWorktree
    } as unknown as Parameters<typeof killAllProcessesForWorktree>[1]['runtime']
    const localProvider = createProviderStub(async () => [])
    listRegisteredPtysMock.mockReturnValue([])

    await expect(
      killAllProcessesForWorktree('w1', {
        runtime,
        localProvider,
        requirePhysicalStop: true
      })
    ).rejects.toThrow('runtime sweep failed')
  })

  it('bounds the entire process sweep when a provider never settles', async () => {
    vi.useFakeTimers()
    try {
      const localProvider = createProviderStub(() => new Promise(() => {}))
      listRegisteredPtysMock.mockReturnValue([
        { ptyId: 'registry-1', worktreeId: 'w1', sessionId: null, paneKey: null, pid: 12 }
      ])
      let completed = false
      const teardown = killAllProcessesForWorktree('w1', {
        localProvider,
        timeoutMs: WORKTREE_PROCESS_SWEEP_TIMEOUT_MS
      }).then((result) => {
        completed = true
        return result
      })

      await vi.advanceTimersByTimeAsync(WORKTREE_PROCESS_SWEEP_TIMEOUT_MS - 1)
      expect(completed).toBe(false)
      await vi.advanceTimersByTimeAsync(1)

      await expect(teardown).resolves.toEqual({
        runtimeStopped: 0,
        providerStopped: 0,
        registryStopped: 1
      })
      expect(localProvider.shutdown).toHaveBeenCalledWith(
        'registry-1',
        expect.objectContaining({ immediate: true })
      )
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not issue shutdown after a timed-out provider list settles late', async () => {
    vi.useFakeTimers()
    try {
      let resolveList: (sessions: { id: string; cwd: string; title: string }[]) => void = () => {}
      const localProvider = createProviderStub(
        () =>
          new Promise((resolve) => {
            resolveList = resolve
          })
      )
      listRegisteredPtysMock.mockReturnValue([])
      const teardown = killAllProcessesForWorktree('w1', { localProvider, timeoutMs: 25 })

      await vi.advanceTimersByTimeAsync(25)
      await expect(teardown).resolves.toMatchObject({ providerStopped: 0 })
      resolveList([{ id: 'w1@@replacement', cwd: '/new', title: 'new' }])
      await Promise.resolve()

      expect(localProvider.shutdown).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not mutate PTY state after a shutdown settles beyond the deadline', async () => {
    vi.useFakeTimers()
    try {
      let resolveShutdown: () => void = () => {}
      const localProvider = createProviderStub(async () => [])
      ;(localProvider.shutdown as unknown as ReturnType<typeof vi.fn>).mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            resolveShutdown = resolve
          })
      )
      listRegisteredPtysMock.mockReturnValue([
        { ptyId: 'registry-1', worktreeId: 'w1', sessionId: null, paneKey: null, pid: 12 }
      ])
      const onPtyStopped = vi.fn()
      const teardown = killAllProcessesForWorktree('w1', {
        localProvider,
        onPtyStopped,
        timeoutMs: 25
      })

      await vi.advanceTimersByTimeAsync(25)
      await expect(teardown).resolves.toMatchObject({ registryStopped: 0 })
      resolveShutdown()
      await Promise.resolve()

      expect(onPtyStopped).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})
