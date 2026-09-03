import { describe, expect, it, vi } from 'vitest'
import { RelayPublicAssignmentAdmission } from './public-assignment-admission.js'

describe('public assignment admission', () => {
  it('bounds global concurrency and repeated work for one relay host', async () => {
    let now = 0
    const admission = new RelayPublicAssignmentAdmission({
      maxConcurrent: 2,
      minIntervalMs: 5_000,
      now: () => now
    })
    const first = await admission.acquire('host-a')
    expect(first).not.toBeNull()
    await expect(admission.acquire('host-a')).resolves.toBeNull()
    const second = await admission.acquire('host-b')
    expect(second).not.toBeNull()
    await expect(admission.acquire('host-c')).resolves.toBeNull()

    first?.release()
    await expect(admission.acquire('host-a')).resolves.toBeNull()
    now = 5_000
    const recovered = await admission.acquire('host-a')
    expect(recovered).not.toBeNull()
    recovered?.release()
    second?.release()
  })

  it('releases capacity once when callers settle more than once', async () => {
    const admission = new RelayPublicAssignmentAdmission({
      maxConcurrent: 1,
      minIntervalMs: 0,
      now: vi.fn(() => 0)
    })
    const lease = await admission.acquire('host-a')
    lease?.release()
    lease?.release()
    await expect(admission.acquire('host-b')).resolves.not.toBeNull()
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

  it('fails an ordinary wait closed when its bounded wait expires', async () => {
    let expire!: () => void
    const admission = new RelayPublicAssignmentAdmission({
      maxConcurrent: 1,
      maxQueued: 1,
      waitMs: 1_000,
      minIntervalMs: 0,
      schedule: (callback) => {
        expire = callback
        return () => undefined
      }
    })
    const first = await admission.acquire('host-a')
    const waiting = admission.acquire('host-b')

    expire()
    await expect(waiting).resolves.toBeNull()
    first?.release()
  })

  it('gives a bounded reserved waiter the next public slot', async () => {
    let expire!: () => void
    let cancelled = false
    const admission = new RelayPublicAssignmentAdmission({
      maxConcurrent: 2,
      maxReservedConcurrent: 1,
      reservedWaitMs: 1_000,
      minIntervalMs: 0,
      schedule: (callback) => {
        expire = callback
        return () => {
          cancelled = true
        }
      }
    })
    const first = await admission.acquire('host-a')
    const second = await admission.acquire('host-b')
    const reservedPromise = admission.acquireReserved('host-c')

    await expect(admission.acquire('host-d')).resolves.toBeNull()
    await expect(admission.acquireReserved('host-e')).resolves.toBeNull()
    first?.release()
    const reserved = await reservedPromise

    expect(reserved).not.toBeNull()
    expect(cancelled).toBe(true)
    await expect(admission.acquire('host-d')).resolves.toBeNull()
    reserved?.release()
    await expect(admission.acquire('host-d')).resolves.not.toBeNull()
    second?.release()
    expire()
  })

  it('lets reserved recovery displace the same host from the ordinary queue', async () => {
    const admission = new RelayPublicAssignmentAdmission({
      maxConcurrent: 1,
      maxQueued: 1,
      waitMs: 1_000,
      maxReservedConcurrent: 1,
      reservedWaitMs: 1_000,
      minIntervalMs: 0,
      schedule: () => () => undefined
    })
    const active = await admission.acquire('host-a')
    const ordinary = admission.acquire('host-b')
    const reserved = admission.acquireReserved('host-b')

    await expect(ordinary).resolves.toBeNull()
    active?.release()
    const recovered = await reserved
    expect(recovered).not.toBeNull()
    recovered?.release()
  })

  it('fails a reserved wait closed when its bounded wait expires', async () => {
    let expire!: () => void
    const admission = new RelayPublicAssignmentAdmission({
      maxConcurrent: 2,
      maxReservedConcurrent: 1,
      reservedWaitMs: 1_000,
      minIntervalMs: 0,
      schedule: (callback) => {
        expire = callback
        return () => undefined
      }
    })
    const first = await admission.acquire('host-a')
    const second = await admission.acquire('host-b')
    const reserved = admission.acquireReserved('host-c')

    expire()
    await expect(reserved).resolves.toBeNull()
    first?.release()
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

  it('separates a self-throttled host from a saturated director', async () => {
    let now = 0
    const reasons: string[] = []
    const admission = new RelayPublicAssignmentAdmission({
      maxConcurrent: 1,
      maxQueued: 0,
      minIntervalMs: 5_000,
      now: () => now,
      onRejected: (reason) => reasons.push(reason)
    })
    const held = await admission.acquire('host-a')

    // Same host while its own attempt is still running.
    await expect(admission.acquire('host-a')).resolves.toBeNull()
    // A different host with the single slot taken and no queue.
    await expect(admission.acquire('host-b')).resolves.toBeNull()
    held?.release()
    // Same host again, now inside its retry penalty rather than in flight.
    await expect(admission.acquire('host-a')).resolves.toBeNull()

    expect(reasons).toEqual(['host-in-flight', 'queue-full', 'host-rate-limited'])

    now = 5_000
    const recovered = await admission.acquire('host-a')
    expect(recovered).not.toBeNull()
    expect(reasons).toHaveLength(3)
    recovered?.release()
  })

  it('reports a timed-out wait separately from a full queue', async () => {
    let expire!: () => void
    const reasons: string[] = []
    const admission = new RelayPublicAssignmentAdmission({
      maxConcurrent: 1,
      maxQueued: 1,
      waitMs: 1_000,
      minIntervalMs: 0,
      schedule: (callback) => {
        expire = callback
        return () => undefined
      },
      onRejected: (reason) => reasons.push(reason)
    })
    const first = await admission.acquire('host-a')
    const waiting = admission.acquire('host-b')

    expire()
    await expect(waiting).resolves.toBeNull()
    expect(reasons).toEqual(['wait-timeout'])
    first?.release()
  })

  it('reports a displaced queue entry as superseded, not as a timeout', async () => {
    const reasons: string[] = []
    const admission = new RelayPublicAssignmentAdmission({
      maxConcurrent: 1,
      maxQueued: 1,
      waitMs: 1_000,
      maxReservedConcurrent: 1,
      reservedWaitMs: 1_000,
      minIntervalMs: 0,
      schedule: () => () => undefined,
      onRejected: (reason) => reasons.push(reason)
    })
    const active = await admission.acquire('host-a')
    const ordinary = admission.acquire('host-b')
    const reserved = admission.acquireReserved('host-b')

    await expect(ordinary).resolves.toBeNull()
    expect(reasons).toEqual(['superseded'])
    active?.release()
    const recovered = await reserved
    expect(recovered).not.toBeNull()
    recovered?.release()
  })

  it('distinguishes a busy reserved lane from a reserved host already in flight', async () => {
    const reasons: string[] = []
    const admission = new RelayPublicAssignmentAdmission({
      maxConcurrent: 4,
      // Two slots so the lane still has room when the same host asks twice.
      maxReservedConcurrent: 2,
      reservedWaitMs: 1_000,
      minIntervalMs: 0,
      schedule: () => () => undefined,
      onRejected: (reason) => reasons.push(reason)
    })
    const reserved = await admission.acquireReserved('host-a')
    expect(reserved).not.toBeNull()

    await expect(admission.acquireReserved('host-a')).resolves.toBeNull()
    expect(reasons).toEqual(['host-in-flight'])

    const second = await admission.acquireReserved('host-b')
    expect(second).not.toBeNull()
    await expect(admission.acquireReserved('host-c')).resolves.toBeNull()

    expect(reasons).toEqual(['host-in-flight', 'reserved-unavailable'])
    reserved?.release()
    second?.release()
  })

  it('tells each caller its own rejection reason without crossing requests', async () => {
    const admission = new RelayPublicAssignmentAdmission({
      maxConcurrent: 1,
      maxQueued: 1,
      waitMs: 1_000,
      maxReservedConcurrent: 1,
      reservedWaitMs: 1_000,
      minIntervalMs: 5_000,
      now: () => 0,
      schedule: () => () => undefined
    })
    const queued: string[] = []
    const displaced: string[] = []
    const throttled: string[] = []

    const active = await admission.acquire('host-a')
    // 'host-b' waits, then reserved recovery for the same host displaces it.
    const ordinary = admission.acquire('host-b', (reason) => displaced.push(reason))
    const reserved = admission.acquireReserved('host-b', (reason) => queued.push(reason))
    await expect(ordinary).resolves.toBeNull()
    active?.release()
    const recovered = await reserved
    recovered?.release()
    await admission.acquire('host-a', (reason) => throttled.push(reason))

    expect(displaced).toEqual(['superseded'])
    expect(queued).toEqual([])
    expect(throttled).toEqual(['host-rate-limited'])
  })

  it('stays silent on every granted acquisition', async () => {
    const reasons: string[] = []
    const admission = new RelayPublicAssignmentAdmission({
      maxConcurrent: 2,
      maxReservedConcurrent: 1,
      minIntervalMs: 0,
      onRejected: (reason) => reasons.push(reason)
    })
    const first = await admission.acquire('host-a')
    const second = await admission.acquireReserved('host-b')

    expect(first).not.toBeNull()
    expect(second).not.toBeNull()
    expect(reasons).toEqual([])
    first?.release()
    second?.release()
  })
})
