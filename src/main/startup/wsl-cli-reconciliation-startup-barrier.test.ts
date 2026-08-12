import { describe, expect, it, vi } from 'vitest'
import {
  WSL_CLI_RECONCILIATION_STARTUP_BUDGET_MS,
  createWslCliReconciliationStartupBarrier
} from './wsl-cli-reconciliation-startup-barrier'

describe('createWslCliReconciliationStartupBarrier', () => {
  it('resolves as soon as reconciliation finishes', async () => {
    vi.useFakeTimers()
    let resolveReconciliation!: () => void

    try {
      const reconciliation = new Promise<void>((resolve) => {
        resolveReconciliation = resolve
      })
      const barrier = createWslCliReconciliationStartupBarrier(reconciliation)
      let barrierSettled = false
      void barrier.then(() => {
        barrierSettled = true
      })

      await vi.advanceTimersByTimeAsync(1)
      expect(barrierSettled).toBe(false)

      resolveReconciliation()
      await expect(barrier).resolves.toBeUndefined()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('fails open immediately when reconciliation rejects before the budget expires', async () => {
    vi.useFakeTimers()
    let rejectReconciliation!: (error: Error) => void

    try {
      const reconciliation = new Promise<void>((_resolve, reject) => {
        rejectReconciliation = reject
      })
      const barrier = createWslCliReconciliationStartupBarrier(reconciliation)
      let barrierSettled = false
      void barrier.then(() => {
        barrierSettled = true
      })

      await vi.advanceTimersByTimeAsync(1)
      expect(barrierSettled).toBe(false)

      // Why: a fast WSL discovery failure should release the barrier via its catch
      // branch without waiting out the budget, and must clear the pending timer.
      rejectReconciliation(new Error('WSL discovery failed'))
      await expect(barrier).resolves.toBeUndefined()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('lets serve reach RPC readiness at budget while reconciliation remains pending', async () => {
    vi.useFakeTimers()
    let resolveReconciliation!: () => void
    let reconciliationCompleted = false

    try {
      const reconciliation = new Promise<void>((resolve) => {
        resolveReconciliation = resolve
      }).then(() => {
        reconciliationCompleted = true
      })
      const barrier = createWslCliReconciliationStartupBarrier(reconciliation)
      let rpcReady = false
      const serveRpcReadiness = barrier.then(() => {
        rpcReady = true
      })

      await vi.advanceTimersByTimeAsync(WSL_CLI_RECONCILIATION_STARTUP_BUDGET_MS - 1)
      expect(rpcReady).toBe(false)
      expect(reconciliationCompleted).toBe(false)

      await vi.advanceTimersByTimeAsync(1)
      await expect(serveRpcReadiness).resolves.toBeUndefined()
      expect(rpcReady).toBe(true)
      expect(reconciliationCompleted).toBe(false)

      resolveReconciliation()
      await reconciliation
      expect(reconciliationCompleted).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('preserves eventual reconciliation error reporting after the budget expires', async () => {
    vi.useFakeTimers()
    let rejectReconciliation!: (error: Error) => void
    const reportedErrors: string[] = []

    try {
      const reconciliation = new Promise<void>((_resolve, reject) => {
        rejectReconciliation = reject
      }).catch((error) => {
        reportedErrors.push(error instanceof Error ? error.message : String(error))
      })
      const barrier = createWslCliReconciliationStartupBarrier(reconciliation, { timeoutMs: 10 })

      await vi.advanceTimersByTimeAsync(10)
      await expect(barrier).resolves.toBeUndefined()
      expect(reportedErrors).toEqual([])

      rejectReconciliation(new Error('WSL discovery failed'))
      await reconciliation
      expect(reportedErrors).toEqual(['WSL discovery failed'])
    } finally {
      vi.useRealTimers()
    }
  })
})
