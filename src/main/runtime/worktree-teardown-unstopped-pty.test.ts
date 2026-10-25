import { beforeEach, describe, expect, it, vi } from 'vitest'

const { listRegisteredPtysMock } = vi.hoisted(() => ({
  listRegisteredPtysMock: vi.fn()
}))

vi.mock('../memory/pty-registry', () => ({
  listRegisteredPtys: listRegisteredPtysMock
}))

import { killAllProcessesForWorktree, WORKTREE_PROCESS_SWEEP_TIMEOUT_MS } from './worktree-teardown'
import { ABANDONED_SWEEP_GRACE_MS } from './forced-sweep-settlement'
import {
  classifyWorktreeForceDeleteReason,
  isProvenLivePtyRemovalError
} from '../../shared/worktree/removal'
import type { IPtyProvider, PtyProcessInfo } from '../providers/pty-provider-contract'

// Attach a handler before fake-time advancement so rejections stay attributed to this test, without changing the returned promise.
function settleTeardown<T>(promise: Promise<T>): Promise<T> {
  void promise.catch(() => undefined)
  return promise
}

function createProviderStub(listProcesses: () => Promise<PtyProcessInfo[]>): IPtyProvider {
  return {
    shutdown: vi.fn().mockResolvedValue(undefined),
    listProcesses: vi.fn(listProcesses),
    onData: vi.fn().mockReturnValue(() => {}),
    onReplay: vi.fn().mockReturnValue(() => {}),
    onExit: vi.fn().mockReturnValue(() => {})
  } as unknown as IPtyProvider
}

// Unproven PTY stops must retain the Force Delete escape hatch (#11960).
describe('destructive teardown when a PTY stop cannot be proven', () => {
  beforeEach(() => {
    listRegisteredPtysMock.mockReset()
  })

  // Verification needs a fresh budget after sweeps exhaust theirs or confirmed exits stay unverifiable (#11960).
  it('verifies a failed stop against a fresh budget when the sweeps spent the deadline', async () => {
    vi.useFakeTimers()
    try {
      const localProvider = createProviderStub(
        () => new Promise((resolve) => setTimeout(() => resolve([]), 90))
      )
      ;(localProvider.shutdown as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Session not found: stale-1')
      )
      listRegisteredPtysMock.mockReturnValue([
        { ptyId: 'stale-1', worktreeId: 'w1', sessionId: null, paneKey: null, pid: 100 }
      ])

      const teardown = settleTeardown(
        killAllProcessesForWorktree('w1', {
          localProvider,
          timeoutMs: 100,
          requirePhysicalStop: true
        })
      )
      await vi.runAllTimersAsync()

      await expect(teardown).resolves.toEqual({
        runtimeStopped: 0,
        providerStopped: 0,
        registryStopped: 0
      })
    } finally {
      vi.useRealTimers()
    }
  })

  // Stale registry entry plus slow inventory must still let verification prove absence.
  it('removes the reported wedged automation workspace without --force', async () => {
    const worktreeId = 'repo-1::C:/Users/admin/orca/workspaces/repo/auto-review-run-28'
    // Keep list completion away from the timeout tick; a 100ms margin raced under parallel load.
    const listDelayMs = WORKTREE_PROCESS_SWEEP_TIMEOUT_MS / 2
    vi.useFakeTimers()
    try {
      const localProvider = createProviderStub(
        () => new Promise((resolve) => setTimeout(() => resolve([]), listDelayMs))
      )
      ;(localProvider.shutdown as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Session not found: term_abab11ee')
      )
      listRegisteredPtysMock.mockReturnValue([
        { ptyId: 'term_abab11ee', worktreeId, sessionId: null, paneKey: null, pid: 4242 }
      ])

      const teardown = settleTeardown(
        killAllProcessesForWorktree(worktreeId, {
          localProvider,
          requirePhysicalStop: true
        })
      )
      await vi.runAllTimersAsync()

      await expect(teardown).resolves.toEqual({
        runtimeStopped: 0,
        providerStopped: 0,
        registryStopped: 0
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('names the blocking PTYs and the escape hatch when one is still live', async () => {
    const localProvider = createProviderStub(async () => [
      { id: 'w1@@live-1', cwd: '/tmp/w1', title: 'shell' }
    ])
    ;(localProvider.shutdown as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('kill failed')
    )
    listRegisteredPtysMock.mockReturnValue([])

    await expect(
      killAllProcessesForWorktree('w1', { localProvider, requirePhysicalStop: true })
    ).rejects.toThrow(/still live: w1@@live-1[\s\S]*--force/)
  })

  it('clears PTY state once a failed stop is proven to have exited', async () => {
    const localProvider = createProviderStub(async () => [])
    ;(localProvider.shutdown as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Session not found: stale-1')
    )
    listRegisteredPtysMock.mockReturnValue([
      { ptyId: 'stale-1', worktreeId: 'w1', sessionId: null, paneKey: null, pid: 100 }
    ])
    const onPtyStopped = vi.fn()

    await expect(
      killAllProcessesForWorktree('w1', {
        localProvider,
        onPtyStopped,
        requirePhysicalStop: true
      })
    ).resolves.toBeDefined()
    expect(onPtyStopped).toHaveBeenCalledWith('stale-1')
  })

  it('names only the PTYs that are actually live, not every failed stop', async () => {
    const localProvider = createProviderStub(async () => [
      { id: 'w1@@live-1', cwd: '/tmp/w1', title: 'shell' }
    ])
    ;(localProvider.shutdown as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('kill failed')
    )
    listRegisteredPtysMock.mockReturnValue([
      { ptyId: 'w1@@gone-2', worktreeId: 'w1', sessionId: null, paneKey: null, pid: 101 }
    ])

    const error = await killAllProcessesForWorktree('w1', {
      localProvider,
      requirePhysicalStop: true
    }).then(
      () => new Error('expected a rejection'),
      (rejection: Error) => rejection
    )
    expect(error.message).toContain('w1@@live-1')
    expect(error.message).not.toContain('w1@@gone-2')
  })

  // A different provider's empty list cannot prove an unreachable SSH host's PTY exited.
  it("blocks removal when the stop lost contact with the PTY's own host", async () => {
    // Retain the owning-host verdict; local absence cannot prove remote exit.
    const localProvider = createProviderStub(async () => [])
    listRegisteredPtysMock.mockReturnValue([])
    const runtime = {
      stopTerminalsForWorktree: async (
        _worktreeId: string,
        opts: {
          stopPty?: (
            ptyId: string,
            stop: () => boolean | Promise<boolean>
          ) => Promise<{ stopped: boolean; owner: boolean }>
        }
      ) => {
        await opts.stopPty?.('ssh:conn-1@@relay-9', () => false)
        return { stopped: 0 }
      },
      getPtyLivenessVerdict: (ptyId: string) =>
        ptyId === 'ssh:conn-1@@relay-9'
          ? { status: 'unverifiable', reason: 'its SSH provider is no longer registered' }
          : null
    }

    await expect(
      killAllProcessesForWorktree('w1', {
        runtime: runtime as never,
        localProvider,
        resolvedConnectionId: 'conn-1',
        includeProviderInventory: false,
        includeLocalRegistry: false,
        requirePhysicalStop: true
      })
    ).rejects.toThrow(
      /could not verify[\s\S]*ssh:conn-1@@relay-9[\s\S]*SSH provider is no longer registered[\s\S]*--force/
    )
  })

  it('does not infer a remote exit from fallback local inventory without a cached verdict', async () => {
    const localProvider = createProviderStub(async () => [])
    listRegisteredPtysMock.mockReturnValue([])
    const runtime = {
      stopTerminalsForWorktree: async (
        _worktreeId: string,
        opts: {
          stopPty?: (
            ptyId: string,
            stop: () => boolean | Promise<boolean>
          ) => Promise<{ stopped: boolean; owner: boolean }>
        }
      ) => {
        await opts.stopPty?.('ssh:conn-1@@relay-10', () => false)
        return { stopped: 0 }
      },
      getPtyLivenessVerdict: () => null
    }

    await expect(
      killAllProcessesForWorktree('w1', {
        runtime: runtime as never,
        localProvider,
        resolvedConnectionId: 'conn-1',
        includeProviderInventory: false,
        includeLocalRegistry: false,
        requirePhysicalStop: true
      })
    ).rejects.toThrow(/could not verify[\s\S]*no registered provider can observe its host/)
    expect(localProvider.listProcesses).not.toHaveBeenCalled()
  })

  it('reports unverifiable separately from live when the process list fails', async () => {
    const localProvider = createProviderStub(async () => {
      throw new Error('daemon socket closed')
    })
    listRegisteredPtysMock.mockReturnValue([
      { ptyId: 'stale-1', worktreeId: 'w1', sessionId: null, paneKey: null, pid: 100 }
    ])
    ;(localProvider.shutdown as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Session not found: stale-1')
    )

    await expect(
      killAllProcessesForWorktree('w1', {
        localProvider,
        includeProviderInventory: false,
        requirePhysicalStop: true
      })
    ).rejects.toThrow(/could not verify[\s\S]*stale-1[\s\S]*daemon socket closed/)
  })

  // Force must also cross sweep failures before the unproven-stop gate.
  it('lets force through a provider whose inventory rejects outright', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      listRegisteredPtysMock.mockReturnValue([])
      const localProvider = createProviderStub(async () => {
        throw new Error('ssh channel closed')
      })

      await expect(
        killAllProcessesForWorktree('w1', {
          localProvider,
          requirePhysicalStop: true,
          allowUnverifiedStop: true
        })
      ).resolves.toEqual({ runtimeStopped: 0, providerStopped: 0, registryStopped: 0 })
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('ssh channel closed'))
    } finally {
      warn.mockRestore()
    }
  })

  it('lets force through a sweep that never settles before the deadline', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.useFakeTimers()
    // Resolve the stub after timeout so its continuation cannot leak into another test.
    let releaseList: (sessions: PtyProcessInfo[]) => void = () => {}
    try {
      listRegisteredPtysMock.mockReturnValue([])
      const localProvider = createProviderStub(
        () =>
          new Promise<PtyProcessInfo[]>((resolve) => {
            releaseList = resolve
          })
      )

      const teardown = settleTeardown(
        killAllProcessesForWorktree('w1', {
          localProvider,
          timeoutMs: 100,
          requirePhysicalStop: true,
          allowUnverifiedStop: true
        })
      )
      await vi.runAllTimersAsync()

      await expect(teardown).resolves.toEqual({
        runtimeStopped: 0,
        providerStopped: 0,
        registryStopped: 0
      })
      // Warn when force outlives an uncancelled sweep; its PTY may still hold the deleted directory.
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(`still running after the ${ABANDONED_SWEEP_GRACE_MS}ms grace`)
      )
    } finally {
      releaseList([])
      await vi.advanceTimersByTimeAsync(0)
      vi.useRealTimers()
      warn.mockRestore()
    }
  })

  // Force must join active shutdowns before filesystem deletion or Windows can fail with EBUSY.
  it('waits for in-flight sweeps before force returns', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const localProvider = createProviderStub(async () => {
        throw new Error('ssh channel closed')
      })
      let shutdownFinished = false
      ;(localProvider.shutdown as unknown as ReturnType<typeof vi.fn>).mockImplementation(
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 20))
          shutdownFinished = true
        }
      )
      listRegisteredPtysMock.mockReturnValue([
        { ptyId: 'reg-1', worktreeId: 'w1', sessionId: null, paneKey: null, pid: 100 }
      ])

      const result = await killAllProcessesForWorktree('w1', {
        localProvider,
        requirePhysicalStop: true,
        allowUnverifiedStop: true
      })

      expect(shutdownFinished).toBe(true)
      expect(result.registryStopped).toBe(1)
    } finally {
      warn.mockRestore()
    }
  })

  // Report the specific provider failure before generic deadline evidence.
  it('warns with the specific sweep failure, not the generic deadline', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.useFakeTimers()
    try {
      listRegisteredPtysMock.mockReturnValue([])
      const localProvider = createProviderStub(async () => {
        throw new Error('ssh channel closed')
      })
      const runtime = {
        stopTerminalsForWorktree: () => new Promise(() => {})
      } as unknown as Parameters<typeof killAllProcessesForWorktree>[1]['runtime']

      const teardown = settleTeardown(
        killAllProcessesForWorktree('w1', {
          runtime,
          localProvider,
          timeoutMs: 100,
          requirePhysicalStop: true,
          allowUnverifiedStop: true
        })
      )
      await vi.runAllTimersAsync()
      await teardown

      const warning = warn.mock.calls.at(-1)?.[0] as string
      expect(warning).toContain('ssh channel closed')
      // Keep both signals, with the specific cause first.
      expect(warning).toContain('Timed out waiting')
      expect(warning.indexOf('ssh channel closed')).toBeLessThan(
        warning.indexOf('Timed out waiting')
      )
    } finally {
      vi.useRealTimers()
      warn.mockRestore()
    }
  })

  it('still fails closed on a sweep-level failure without force', async () => {
    listRegisteredPtysMock.mockReturnValue([])
    const localProvider = createProviderStub(async () => {
      throw new Error('ssh channel closed')
    })

    await expect(
      killAllProcessesForWorktree('w1', { localProvider, requirePhysicalStop: true })
    ).rejects.toThrow('ssh channel closed')
  })

  // Wrap raw provider failures in recognizable force-removal wording without losing their cause (#11960).
  it('offers force delete for a sweep-level failure without losing the provider wording', async () => {
    listRegisteredPtysMock.mockReturnValue([])
    const localProvider = createProviderStub(async () => {
      throw new Error('SSH channel closed while listing processes')
    })

    const error = await killAllProcessesForWorktree('repo-1::/w', {
      localProvider,
      requirePhysicalStop: true
    }).then(
      () => new Error('expected a rejection'),
      (rejection: Error) => rejection
    )
    expect(error.message).toContain('SSH channel closed while listing processes')
    expect(classifyWorktreeForceDeleteReason(error.message)).toBe('unstopped-pty')
    expect(isProvenLivePtyRemovalError(error.message)).toBe(false)
  })

  // Timeout does not cancel shutdown; force must await it before deletion to avoid partial Windows removal.
  it('waits for a shutdown the deadline abandoned before force returns', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let releaseShutdown: () => void = () => {}
    try {
      listRegisteredPtysMock.mockReturnValue([])
      const localProvider = createProviderStub(async () => [
        { id: 'w1@@live-1', cwd: '/tmp/w1', title: 'shell' }
      ])
      let shutdownFinished = false
      ;(localProvider.shutdown as unknown as ReturnType<typeof vi.fn>).mockImplementation(
        async () =>
          await new Promise<void>((resolve) => {
            releaseShutdown = () => {
              shutdownFinished = true
              resolve()
            }
          })
      )

      const teardown = settleTeardown(
        killAllProcessesForWorktree('w1', {
          localProvider,
          timeoutMs: 30,
          requirePhysicalStop: true,
          allowUnverifiedStop: true
        })
      )
      let returned = false
      void teardown.then(() => {
        returned = true
      })
      await new Promise((resolve) => setTimeout(resolve, 150))

      expect(shutdownFinished).toBe(false)
      expect(returned).toBe(false)
      releaseShutdown()
      await expect(teardown).resolves.toEqual({
        runtimeStopped: 0,
        providerStopped: 0,
        registryStopped: 0
      })
    } finally {
      releaseShutdown()
      warn.mockRestore()
    }
  })

  it('lets an explicit force removal proceed past PTYs it could not stop', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const localProvider = createProviderStub(async () => [
        { id: 'w1@@live-1', cwd: '/tmp/w1', title: 'shell' }
      ])
      ;(localProvider.shutdown as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('kill failed')
      )
      listRegisteredPtysMock.mockReturnValue([])
      const onPtyStopped = vi.fn()

      await expect(
        killAllProcessesForWorktree('w1', {
          localProvider,
          onPtyStopped,
          requirePhysicalStop: true,
          allowUnverifiedStop: true
        })
      ).resolves.toMatchObject({ providerStopped: 0 })
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('w1@@live-1'))
      // Keep proven-live PTYs discoverable for users and later sweeps.
      expect(onPtyStopped).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })
})
