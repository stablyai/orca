import { describe, expect, it, vi } from 'vitest'
import {
  ExternalAutomationProbeCancelledError,
  ExternalAutomationProbeScheduler
} from './external-automation-probe-scheduler'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

describe('ExternalAutomationProbeScheduler', () => {
  it('parks queued probes while Orca automation work holds priority', async () => {
    const scheduler = new ExternalAutomationProbeScheduler({ concurrency: 4 })
    const run = vi.fn(() => Promise.resolve('manager'))

    const release = scheduler.beginPriorityWork()
    const probe = scheduler.schedule({ key: 'openclaw@self', scopeKey: 'owner:desktop:self', run })

    expect(run).not.toHaveBeenCalled()
    expect(scheduler.queued).toBe(1)

    release()
    await probe
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('does not start a duplicate key while cancelled provider work is still settling', async () => {
    const scheduler = new ExternalAutomationProbeScheduler({ concurrency: 2 })
    const never = deferred<string>()
    const run = vi.fn(() => never.promise)
    const first = scheduler.schedule({ key: 'openclaw@self', scopeKey: 'self', run })

    scheduler.cancelAll()
    const second = scheduler.schedule({ key: 'openclaw@self', scopeKey: 'self', run })

    await expect(first).rejects.toBeInstanceOf(ExternalAutomationProbeCancelledError)
    await expect(second).rejects.toBeInstanceOf(ExternalAutomationProbeCancelledError)
    expect(run).toHaveBeenCalledTimes(1)

    never.resolve('ignored')
    await vi.waitFor(() => expect(scheduler.inFlight).toBe(0))
  })
})
