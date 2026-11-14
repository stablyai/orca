import { describe, expect, it } from 'vitest'
import { RelayPublicAssignmentAdmission } from './public-assignment-admission.js'

describe('public assignment admission', () => {

  it('releases capacity once when callers settle more than once', async () => {
    const admission = new RelayPublicAssignmentAdmission({
      maxConcurrent: 1,
      minIntervalMs: 0,
      now: () => 0
    })
    const lease = await admission.acquire('host-a')
    expect(lease).not.toBeNull()
    lease?.release()
    const next = await admission.acquire('host-b')
    expect(next).not.toBeNull()
    lease?.release()
    await expect(admission.acquire('host-c')).resolves.toBeNull()
    next?.release()
  })

  it('grants ordinary waiters in FIFO order without raising concurrency', async () => {
    const admission = new RelayPublicAssignmentAdmission({
      maxConcurrent: 1,
      maxQueued: 2,
      waitMs: 1_000,
      minIntervalMs: 0,
      schedule: () => () => undefined
    })
    const first = await admission.acquire('host-a')
    const secondPromise = admission.acquire('host-b')
    const thirdPromise = admission.acquire('host-c')

    await expect(admission.acquire('host-d')).resolves.toBeNull()
    first?.release()
    const second = await secondPromise
    expect(second).not.toBeNull()
    let thirdSettled = false
    void thirdPromise.then(() => { thirdSettled = true })
    await Promise.resolve()
    expect(thirdSettled).toBe(false)
    second?.release()
    const third = await thirdPromise
    expect(third).not.toBeNull()
    third?.release()
  })

  it('gives a bounded reserved waiter the next public slot', async () => {
    const admission = new RelayPublicAssignmentAdmission({
      maxConcurrent: 2,
      maxReservedConcurrent: 1,
      reservedWaitMs: 1_000,
      minIntervalMs: 0,
      schedule: () => () => undefined
    })
    const first = await admission.acquire('host-a')
    const second = await admission.acquire('host-b')
    const reservedPromise = admission.acquireReserved('host-c')

    await expect(admission.acquire('host-d')).resolves.toBeNull()
    await expect(admission.acquireReserved('host-e')).resolves.toBeNull()
    first?.release()
    const reserved = await reservedPromise

    expect(reserved).not.toBeNull()
    await expect(admission.acquire('host-d')).resolves.toBeNull()
    reserved?.release()
    await expect(admission.acquire('host-d')).resolves.not.toBeNull()
    second?.release()
  })

  it('serializes same-host assignment and reserved recovery without losing priority', async () => {
    const admission = new RelayPublicAssignmentAdmission({
      maxConcurrent: 2,
      maxReservedConcurrent: 1,
      reservedWaitMs: 1_000,
      minIntervalMs: 0,
      schedule: () => () => undefined
    })
    const assignment = await admission.acquire('host-a')
    const reservedPromise = admission.acquireReserved('host-a')

    await Promise.resolve()
    await expect(admission.acquire('host-b')).resolves.toBeNull()
    assignment?.release()
    const reserved = await reservedPromise

    expect(reserved).not.toBeNull()
    await expect(admission.acquire('host-a')).resolves.toBeNull()
    reserved?.release()
    await expect(admission.acquire('host-b')).resolves.not.toBeNull()
  })

})
