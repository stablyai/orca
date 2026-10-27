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
  it('never runs more probes at once than its bound allows', async () => {
    const scheduler = new ExternalAutomationProbeScheduler({ concurrency: 2 })
    const gates = [deferred<string>(), deferred<string>(), deferred<string>()]
    const started: string[] = []

    const promises = gates.map((gate, index) =>
      scheduler.schedule({
        key: `probe-${index}`,
        scopeKey: 'owner:desktop:self',
        run: () => {
          started.push(`probe-${index}`)
          return gate.promise
        }
      })
    )

    expect(started).toEqual(['probe-0', 'probe-1'])
    expect(scheduler.queued).toBe(1)

    gates[0]?.resolve('a')
    await promises[0]
    expect(started).toEqual(['probe-0', 'probe-1', 'probe-2'])

    gates[1]?.resolve('b')
    gates[2]?.resolve('c')
    await Promise.all(promises)
  })

  it('shares one probe between concurrent requests for the same key', async () => {
    const scheduler = new ExternalAutomationProbeScheduler()
    const run = vi.fn(() => Promise.resolve('manager'))

    const [first, second] = await Promise.all([
      scheduler.schedule({ key: 'openclaw@self', scopeKey: 'owner:desktop:self', run }),
      scheduler.schedule({ key: 'openclaw@self', scopeKey: 'owner:desktop:self', run })
    ])

    expect(run).toHaveBeenCalledTimes(1)
    expect(first).toBe('manager')
    expect(second).toBe('manager')
  })

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
