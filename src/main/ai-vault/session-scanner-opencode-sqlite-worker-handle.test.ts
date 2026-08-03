import type { Worker } from 'node:worker_threads'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FakeOpenCodeSqliteWorker } from './fake-opencode-sqlite-worker'
import {
  OpenCodeSqliteWorkerHandle,
  TERMINATE_GRACE_MS
} from './session-scanner-opencode-sqlite-worker-handle'

class WedgedTerminateWorker extends FakeOpenCodeSqliteWorker {
  override terminate(): Promise<number> {
    this.terminated = true
    return new Promise(() => undefined)
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('OpenCodeSqliteWorkerHandle', () => {
  it('logs when worker termination exceeds the grace period', async () => {
    vi.useFakeTimers()
    const log = vi.fn()
    const handle = new OpenCodeSqliteWorkerHandle({
      workerFactory: () => new WedgedTerminateWorker() as unknown as Worker,
      log,
      onMessage() {},
      onFault() {},
      onExit() {},
      onTeardownSettled() {}
    })

    expect(handle.ensure()).not.toBeNull()
    handle.destroy()
    await vi.advanceTimersByTimeAsync(TERMINATE_GRACE_MS)

    expect(log).toHaveBeenCalledWith(
      `OpenCode SQLite worker terminate grace expired after ${TERMINATE_GRACE_MS}ms; replacement may overlap a wedged worker.`
    )
    expect(handle.isTearingDown).toBe(false)
  })
})
