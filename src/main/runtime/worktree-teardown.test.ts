import { beforeEach, describe, expect, it, vi } from 'vitest'

const { listRegisteredPtysMock } = vi.hoisted(() => ({
  listRegisteredPtysMock: vi.fn()
}))

vi.mock('../memory/pty-registry', () => ({
  listRegisteredPtys: listRegisteredPtysMock
}))

import { killAllProcessesForWorktree } from './worktree-teardown'
import type { IPtyProvider } from '../providers/types'

function createProviderStub(
  listProcesses: () => Promise<{ id: string; cwd: string; title: string }[]>
): IPtyProvider {
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

async function releaseBoundedShutdownWaves(
  shutdown: ReturnType<typeof vi.fn>,
  pending: { settle: () => void }[],
  targetCount: number
): Promise<number> {
  await vi.waitFor(() => expect(shutdown).toHaveBeenCalledTimes(8))
  let waves = 0
  while (shutdown.mock.calls.length < targetCount) {
    waves += 1
    const callsBeforeRelease = shutdown.mock.calls.length
    pending.splice(0).forEach(({ settle }) => settle())
    await vi.waitFor(() => expect(shutdown.mock.calls.length).toBeGreaterThan(callsBeforeRelease))
  }
  waves += 1
  pending.splice(0).forEach(({ settle }) => settle())
  return waves
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

    expect(localProvider.shutdown).toHaveBeenCalledWith('w1@@abcd1234', { immediate: true })
    expect(localProvider.shutdown).toHaveBeenCalledWith('w1-registry-1', { immediate: true })
    expect(localProvider.shutdown).not.toHaveBeenCalledWith('w2@@efef5678', { immediate: true })
    expect(localProvider.shutdown).not.toHaveBeenCalledWith('w2-registry-2', { immediate: true })
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
    expect(localProvider.shutdown).toHaveBeenCalledWith('1', { immediate: true })
    expect(localProvider.shutdown).toHaveBeenCalledTimes(1)
    expect(onPtyStopped).toHaveBeenCalledWith('1')
  })

  it('fails closed when the provider inventory cannot be read', async () => {
    const localProvider = createProviderStub(() => Promise.reject(new Error('boom')))
    listRegisteredPtysMock.mockReturnValue([
      { ptyId: 'x', worktreeId: 'w1', sessionId: null, paneKey: null, pid: 10 }
    ])
    ;(localProvider.shutdown as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('already dead')
    )

    await expect(killAllProcessesForWorktree('w1', { localProvider })).rejects.toThrow('boom')
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
    expect(providerA.shutdown).toHaveBeenCalledWith('w1@@aaaa', { immediate: true })
    expect(providerB.shutdown).not.toHaveBeenCalled()
    expect(r1.providerStopped).toBe(1)

    const r2 = await killAllProcessesForWorktree('w1', { localProvider: providerB })
    expect(providerB.shutdown).toHaveBeenCalledWith('w1@@bbbb', { immediate: true })
    expect(providerB.shutdown).toHaveBeenCalledTimes(1)
    expect(r2.providerStopped).toBe(1)
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
      worktreeTeardown: true
    })
    expect(result.runtimeStopped).toBe(3)
  })

  it('fails closed when an SSH-owned runtime PTY cannot be verified stopped', async () => {
    const stopTerminalsForWorktree = vi.fn().mockResolvedValue({
      stopped: 0,
      failedPtyIds: ['ssh:ssh-1@@relay-pty']
    })
    const runtime = {
      stopTerminalsForWorktree
    } as unknown as Parameters<typeof killAllProcessesForWorktree>[1]['runtime']
    const localProvider = createProviderStub(async () => [])
    listRegisteredPtysMock.mockReturnValue([])

    await expect(killAllProcessesForWorktree('w1', { runtime, localProvider })).rejects.toThrow(
      'Failed to stop remote worktree terminals: ssh:ssh-1@@relay-pty'
    )
    expect(localProvider.listProcesses).toHaveBeenCalledTimes(1)
  })

  it('does not sweep a colliding local-provider worktree during SSH teardown', async () => {
    const stopTerminalsForWorktree = vi.fn().mockResolvedValue({ stopped: 1 })
    const runtime = {
      stopTerminalsForWorktree
    } as unknown as Parameters<typeof killAllProcessesForWorktree>[1]['runtime']
    const localProvider = createProviderStub(async () => [
      { id: 'w1@@local-witness', cwd: '/tmp/w1', title: 'shell' }
    ])

    await expect(
      killAllProcessesForWorktree('w1', {
        runtime,
        localProvider,
        connectionId: 'ssh-1'
      })
    ).resolves.toEqual({ runtimeStopped: 1, providerStopped: 0, registryStopped: 0 })
    expect(stopTerminalsForWorktree).toHaveBeenCalledWith('w1', {
      worktreeTeardown: true,
      connectionId: 'ssh-1'
    })
    expect(localProvider.listProcesses).not.toHaveBeenCalled()
    expect(localProvider.shutdown).not.toHaveBeenCalled()
  })

  it('fails closed when a local runtime PTY remains after fallback shutdown rejects', async () => {
    const runtime = {
      stopTerminalsForWorktree: vi.fn().mockResolvedValue({
        stopped: 0,
        failedPtyIds: ['w1@@daemon']
      })
    } as unknown as Parameters<typeof killAllProcessesForWorktree>[1]['runtime']
    const localProvider = createProviderStub(async () => [
      { id: 'w1@@daemon', cwd: '/tmp/w1', title: 'shell' }
    ])
    vi.mocked(localProvider.shutdown).mockRejectedValue(new Error('daemon still alive'))
    listRegisteredPtysMock.mockReturnValue([])

    await expect(killAllProcessesForWorktree('w1', { runtime, localProvider })).rejects.toThrow(
      'Failed to stop local worktree terminals: w1@@daemon'
    )
  })

  it('recovers a failed local runtime stop through one deduplicated provider shutdown', async () => {
    const runtime = {
      stopTerminalsForWorktree: vi.fn().mockResolvedValue({
        stopped: 0,
        failedPtyIds: ['w1@@daemon']
      })
    } as unknown as Parameters<typeof killAllProcessesForWorktree>[1]['runtime']
    const localProvider = createProviderStub(async () => [
      { id: 'w1@@daemon', cwd: '/tmp/w1', title: 'shell' }
    ])
    listRegisteredPtysMock.mockReturnValue([
      { ptyId: 'w1@@daemon', worktreeId: 'w1', sessionId: null, paneKey: null, pid: 10 }
    ])

    await expect(killAllProcessesForWorktree('w1', { runtime, localProvider })).resolves.toEqual({
      runtimeStopped: 0,
      providerStopped: 1,
      registryStopped: 0
    })
    expect(localProvider.shutdown).toHaveBeenCalledTimes(1)
  })

  it('accepts a stale duplicate registry row only after authoritative absence verification', async () => {
    const localProvider = createProviderStub(
      vi
        .fn()
        .mockResolvedValueOnce([{ id: 'w1@@daemon', cwd: '/tmp/w1', title: 'shell' }])
        .mockResolvedValueOnce([])
    )
    vi.mocked(localProvider.shutdown).mockRejectedValue(new Error('not found'))
    listRegisteredPtysMock.mockReturnValue([
      { ptyId: 'w1@@daemon', worktreeId: 'w1', sessionId: null, paneKey: null, pid: 10 }
    ])

    await expect(killAllProcessesForWorktree('w1', { localProvider })).resolves.toEqual({
      runtimeStopped: 0,
      providerStopped: 0,
      registryStopped: 0
    })
    expect(localProvider.listProcesses).toHaveBeenCalledTimes(2)
    expect(localProvider.shutdown).toHaveBeenCalledTimes(1)
  })

  it('bounds a 50-session headless fallback sweep to seven shutdown waves', async () => {
    const sessions = Array.from({ length: 50 }, (_, index) => ({
      id: `w1@@${index}`,
      cwd: '/tmp/w1',
      title: 'shell'
    }))
    const localProvider = createProviderStub(async () => sessions)
    const pending: { settle: () => void }[] = []
    let active = 0
    let peak = 0
    vi.mocked(localProvider.shutdown).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          active += 1
          peak = Math.max(peak, active)
          pending.push({
            settle: () => {
              active -= 1
              resolve()
            }
          })
        })
    )
    listRegisteredPtysMock.mockReturnValue([])

    const teardown = killAllProcessesForWorktree('w1', { localProvider })
    const waves = await releaseBoundedShutdownWaves(
      vi.mocked(localProvider.shutdown),
      pending,
      sessions.length
    )

    await expect(teardown).resolves.toEqual({
      runtimeStopped: 0,
      providerStopped: 50,
      registryStopped: 0
    })
    expect(peak).toBe(8)
    expect(waves).toBe(7)
  })

  it('waits for seven bounded failure waves before rejecting a 50-session sweep', async () => {
    const sessions = Array.from({ length: 50 }, (_, index) => ({
      id: `w1@@${index}`,
      cwd: '/tmp/w1',
      title: 'shell'
    }))
    const localProvider = createProviderStub(async () => sessions)
    const pending: { settle: () => void }[] = []
    let active = 0
    let peak = 0
    vi.mocked(localProvider.shutdown).mockImplementation(
      () =>
        new Promise<void>((_resolve, reject) => {
          active += 1
          peak = Math.max(peak, active)
          pending.push({
            settle: () => {
              active -= 1
              reject(new Error('shutdown timed out after 3000ms'))
            }
          })
        })
    )
    listRegisteredPtysMock.mockReturnValue([])

    const teardown = killAllProcessesForWorktree('w1', { localProvider })
    const waves = await releaseBoundedShutdownWaves(
      vi.mocked(localProvider.shutdown),
      pending,
      sessions.length
    )

    await expect(teardown).rejects.toThrow('Failed to stop local worktree terminals')
    expect(localProvider.listProcesses).toHaveBeenCalledTimes(2)
    expect(peak).toBe(8)
    expect(waves).toBe(7)
  })

  it('awaits each runtime stop before fallback sweeps and preserves unrelated sessions', async () => {
    const releases = new Map<string, () => void>()
    const liveSessions = new Set(['w1@@target', 'w2@@target', 'witness@@unrelated'])
    const stopTerminalsForWorktree = vi.fn(
      (worktreeId: string) =>
        new Promise<{ stopped: number }>((resolve) => {
          releases.set(worktreeId, () => {
            liveSessions.delete(`${worktreeId}@@target`)
            // Why: a spawn that finishes after the runtime snapshot still has
            // to be caught by the later provider sweep before deletion.
            liveSessions.add(`${worktreeId}@@late`)
            resolve({ stopped: 1 })
          })
        })
    )
    const runtime = {
      stopTerminalsForWorktree
    } as unknown as Parameters<typeof killAllProcessesForWorktree>[1]['runtime']
    const localProvider = createProviderStub(async () =>
      [...liveSessions].map((id) => ({ id, cwd: '/tmp', title: 'shell' }))
    )
    listRegisteredPtysMock.mockReturnValue([])

    for (const worktreeId of ['w1', 'w2']) {
      const listCountBeforeStop = vi.mocked(localProvider.listProcesses).mock.calls.length
      const shutdownCountBeforeStop = vi.mocked(localProvider.shutdown).mock.calls.length
      const removal = killAllProcessesForWorktree(worktreeId, { runtime, localProvider })
      await vi.waitFor(() => expect(releases.has(worktreeId)).toBe(true))

      expect(localProvider.listProcesses).toHaveBeenCalledTimes(listCountBeforeStop)
      expect(localProvider.shutdown).toHaveBeenCalledTimes(shutdownCountBeforeStop)
      releases.get(worktreeId)?.()

      await expect(removal).resolves.toEqual({
        runtimeStopped: 1,
        providerStopped: 1,
        registryStopped: 0
      })
      expect(localProvider.shutdown).toHaveBeenCalledWith(`${worktreeId}@@late`, {
        immediate: true
      })
    }

    expect(localProvider.shutdown).not.toHaveBeenCalledWith('witness@@unrelated', {
      immediate: true
    })
    expect(liveSessions.has('witness@@unrelated')).toBe(true)
  })

  it('fails closed on an unexpected runtime worktree-stop failure', async () => {
    const stopTerminalsForWorktree = vi.fn().mockRejectedValue(new Error('graph not ready'))
    const runtime = {
      stopTerminalsForWorktree
    } as unknown as Parameters<typeof killAllProcessesForWorktree>[1]['runtime']

    const localProvider = createProviderStub(async () => [])
    listRegisteredPtysMock.mockReturnValue([])

    await expect(killAllProcessesForWorktree('w1', { runtime, localProvider })).rejects.toThrow(
      'graph not ready'
    )
    expect(localProvider.listProcesses).not.toHaveBeenCalled()
  })
})
