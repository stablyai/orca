import { beforeEach, describe, expect, it, vi } from 'vitest'

const { listRegisteredPtysMock } = vi.hoisted(() => ({
  listRegisteredPtysMock: vi.fn()
}))

vi.mock('../../../memory/pty-registry', () => ({
  listRegisteredPtys: listRegisteredPtysMock
}))

import { killAllProcessesForWorktree } from './worktree-teardown'
import { ABANDONED_SWEEP_GRACE_MS } from './forced-sweep-settlement'
import type { IPtyProvider } from '../../../providers/pty/provider-contract'
import type { PtyProcessInfo } from '../../../providers/pty/process-info'

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

  // A different provider's empty list cannot prove an unreachable SSH host's PTY exited.

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

  // Force must also cross sweep failures before the unproven-stop gate.

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

  // Wrap raw provider failures in recognizable force-removal wording without losing their cause (#11960).

  // Timeout does not cancel shutdown; force must await it before deletion to avoid partial Windows removal.
})
