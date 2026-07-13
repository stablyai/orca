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

  it('fails open when reconciliation exceeds the startup budget', async () => {
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

      await vi.advanceTimersByTimeAsync(WSL_CLI_RECONCILIATION_STARTUP_BUDGET_MS - 1)
      expect(barrierSettled).toBe(false)

      await vi.advanceTimersByTimeAsync(1)
      await expect(barrier).resolves.toBeUndefined()
      resolveReconciliation()
      await reconciliation
    } finally {
      vi.useRealTimers()
    }
  })

  it('leaves reconciliation running after the startup budget expires', async () => {
    vi.useFakeTimers()
    let resolveWork!: () => void
    let completed = false

    try {
      const work = new Promise<void>((resolve) => {
        resolveWork = resolve
      }).then(() => {
        completed = true
      })
      const barrier = createWslCliReconciliationStartupBarrier(work, { timeoutMs: 10 })

      await vi.advanceTimersByTimeAsync(10)
      await expect(barrier).resolves.toBeUndefined()
      expect(completed).toBe(false)

      resolveWork()
      await work
      expect(completed).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})
