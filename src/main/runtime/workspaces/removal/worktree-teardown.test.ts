import { beforeEach, describe, expect, it, vi } from 'vitest'

const { listRegisteredPtysMock } = vi.hoisted(() => ({
  listRegisteredPtysMock: vi.fn()
}))

vi.mock('../../../memory/pty-registry', () => ({
  listRegisteredPtys: listRegisteredPtysMock
}))

import { killAllProcessesForWorktree } from './worktree-teardown'
import type { IPtyProvider } from '../../../providers/pty/provider-contract'
import type { PtyProcessInfo } from '../../../providers/pty/process-info'

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

  it('accepts a failed stop when exact-owner inventory supersedes cached uncertainty', async () => {
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
      stopTerminalsForWorktree,
      getPtyLivenessVerdict: vi.fn(() => ({
        status: 'unverifiable',
        reason: 'the provider disconnected during stop'
      }))
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

  it('keeps cached uncertainty when no provider can observe the owning host', async () => {
    const worktreeId = 'repo-1::/remote/worktree'
    const ptyId = `${worktreeId}@@remote-pty`
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
      stopTerminalsForWorktree,
      getPtyLivenessVerdict: vi.fn(() => ({
        status: 'unverifiable',
        reason: 'no registered provider can observe its host'
      }))
    } as unknown as Parameters<typeof killAllProcessesForWorktree>[1]['runtime']
    const fallbackProvider = createProviderStub(async () => [])
    listRegisteredPtysMock.mockReturnValue([])

    await expect(
      killAllProcessesForWorktree(worktreeId, {
        runtime,
        resolvedConnectionId: 'missing-connection',
        localProvider: fallbackProvider,
        includeProviderInventory: false,
        includeLocalRegistry: false,
        requirePhysicalStop: true
      })
    ).rejects.toThrow('no registered provider can observe its host')
    expect(fallbackProvider.listProcesses).not.toHaveBeenCalled()
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

  // Bound Windows daemon kill RPCs below the sweep deadline so failures report the stop cause (#9500).

  it('tolerates an unresolved runtime selector during destructive removal', async () => {
    // An absent newly created/removed graph entry means no runtime-owned PTYs, not failed teardown.
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
})
