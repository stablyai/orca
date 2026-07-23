import { describe, expect, it, vi } from 'vitest'
import { NativeChatTranscriptReadAdmission } from './transcript-read-admission'

describe('NativeChatTranscriptReadAdmission', () => {
  it('admits only reads that fit both concurrency and aggregate byte limits', async () => {
    const admission = new NativeChatTranscriptReadAdmission(10, 2, 4)
    const releaseSix = await admission.acquire(6)
    const releaseFour = await admission.acquire(4)
    let thirdAdmitted = false
    const third = admission.acquire(1).then((release) => {
      thirdAdmitted = true
      return release
    })

    await Promise.resolve()
    expect(thirdAdmitted).toBe(false)
    expect(admission.activeCount).toBe(2)
    expect(admission.retainedBytes).toBe(10)
    expect(admission.queuedCount).toBe(1)

    releaseFour()
    const releaseThird = await third
    expect(thirdAdmitted).toBe(true)
    expect(admission.retainedBytes).toBe(7)

    releaseSix()
    releaseThird()
    expect(admission.activeCount).toBe(0)
    expect(admission.retainedBytes).toBe(0)
  })

  it('removes an aborted queued read and immediately reuses the slot', async () => {
    const admission = new NativeChatTranscriptReadAdmission(10, 2, 1)
    const releaseActive = await admission.acquire(10)
    const controller = new AbortController()
    const queued = admission.acquire(1, controller.signal)

    expect(admission.queuedCount).toBe(1)
    controller.abort()
    await expect(queued).rejects.toMatchObject({ name: 'AbortError' })
    expect(admission.queuedCount).toBe(0)

    const replacement = admission.acquire(1)
    expect(admission.queuedCount).toBe(1)
    releaseActive()
    const releaseReplacement = await replacement
    releaseReplacement()
  })

  it('bounds queued closures and releases reservations idempotently', async () => {
    const admission = new NativeChatTranscriptReadAdmission(1, 1, 2)
    const releaseActive = await admission.acquire(1)
    const first = admission.acquire(1)
    const second = admission.acquire(1)

    expect(() => admission.acquire(1)).toThrow('Too many queued native chat transcript reads')
    releaseActive()
    releaseActive()
    const releaseFirst = await first
    releaseFirst()
    const releaseSecond = await second
    releaseSecond()

    expect(admission.activeCount).toBe(0)
    expect(admission.retainedBytes).toBe(0)
  })

  it('detaches abort listeners after admission', async () => {
    const admission = new NativeChatTranscriptReadAdmission(1, 1, 1)
    const controller = new AbortController()
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener')

    const release = await admission.acquire(1, controller.signal)

    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function))
    controller.abort()
    expect(admission.activeCount).toBe(1)
    release()
  })
})
