// PHASE-DEADLINES: a create sat 180 s at "Start sandbox" before its write-ahead insert, with no
// provider call stalled. The pre-insert phases are bounded and a stuck one is named in the log.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LifecycleError, PHASE_DEADLINES_MS, phaseTimer } from '../src/lifecycle'

const never = () => new Promise<never>(() => undefined)

describe('PHASE-DEADLINES', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('fails a stuck entitlement phase by name and logs it', async () => {
    const timer = phaseTimer(() => Date.now())
    const run = timer.time('entitlement', never)
    const caught = run.catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(PHASE_DEADLINES_MS.entitlement!.ms)
    const error = await caught
    expect(error).toBeInstanceOf(LifecycleError)
    expect((error as LifecycleError).code).toBe('provider_unavailable')
    expect((error as LifecycleError).reason).toBe('phase_timeout_entitlement')
    expect(timer.failed?.phase).toBe('entitlement')
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('"event":"phase_timeout"'))
  })

  it('only logs a slow pool claim: abandoning it could strand the claimed VM', async () => {
    const timer = phaseTimer(() => Date.now())
    let finish: (value: string) => void = () => undefined
    const run = timer.time('pool', () => new Promise<string>((resolve) => (finish = resolve)))
    await vi.advanceTimersByTimeAsync(PHASE_DEADLINES_MS.pool!.ms + 1_000)
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('"phase":"pool"'))
    finish('vm')
    await expect(run).resolves.toBe('vm')
    expect(timer.failed).toBeNull()
  })

  it('leaves a fast phase and the provider-bounded phases alone', async () => {
    const timer = phaseTimer(() => Date.now())
    await expect(timer.time('environment', async () => 1)).resolves.toBe(1)
    const vm = timer.time('vm', () => new Promise<number>((resolve) => setTimeout(() => resolve(2), 90_000)))
    await vi.advanceTimersByTimeAsync(90_000)
    await expect(vm).resolves.toBe(2)
    expect(console.log).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
})
