import { describe, expect, it, vi } from 'vitest'
import { AiVaultScanCoordinator } from './ai-vault-scan-coordinator'
import { scanRecoveryInterest, nextScanObservationOrder } from './ai-vault-scan-recovery'

const EMPTY = { sessions: [], issues: [], scannedAt: '2026-11-13' }
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('Session History scan ownership', () => {
  it('lets a progressing leading scan finish and coalesces 200 forces into one fresh successor', async () => {
    vi.useFakeTimers()
    try {
      const coordinator = new AiVaultScanCoordinator()
      const leading = deferred<typeof EMPTY>()
      const fresh = { ...EMPTY, scannedAt: 'fresh' }
      let signal!: AbortSignal
      const start = vi.fn((scanSignal: AbortSignal) => {
        signal = scanSignal
        return leading.promise
      })
      const first = coordinator.run({ key: 'scope', start })
      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(13000)
      const successor = vi.fn(async () => fresh)
      const forced = Array.from({ length: 200 }, () =>
        coordinator.run({ key: 'scope', force: true, start: successor })
      )
      await Promise.resolve()
      expect(signal.aborted).toBe(false)
      expect(successor).not.toHaveBeenCalled()
      expect(scanRecoveryInterest(signal)?.inherited).toBe(200)
      leading.resolve(EMPTY)
      await expect(first).resolves.toBe(EMPTY)
      await expect(Promise.all(forced)).resolves.toEqual(Array.from({ length: 200 }, () => fresh))
      expect(successor).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps leading work alive for a trailing owner and cancels it when every owner detaches', async () => {
    const coordinator = new AiVaultScanCoordinator()
    const normal = new AbortController()
    const forced = new AbortController()
    let signal!: AbortSignal
    const start = vi.fn((scanSignal: AbortSignal) => {
      signal = scanSignal
      return new Promise<typeof EMPTY>((resolve) =>
        scanSignal.addEventListener('abort', () => resolve(EMPTY))
      )
    })
    const first = coordinator.run({ key: 'scope', signal: normal.signal, start })
    await Promise.resolve()
    const next = coordinator.run({ key: 'scope', force: true, signal: forced.signal, start })
    normal.abort()
    await expect(first).rejects.toMatchObject({ name: 'AbortError' })
    expect(signal.aborted).toBe(false)
    forced.abort()
    await expect(next).rejects.toMatchObject({ name: 'AbortError' })
    expect(signal.aborted).toBe(true)
    await Promise.resolve()
    expect(start).toHaveBeenCalledTimes(1)
  })

  it('uses a recovered leading result for the forced obligation without a duplicate fresh pass', async () => {
    const coordinator = new AiVaultScanCoordinator()
    const scan = deferred<typeof EMPTY>()
    let signal!: AbortSignal
    const first = coordinator.run({
      key: 'scope',
      start: (value) => {
        signal = value
        return scan.promise
      }
    })
    await Promise.resolve()
    const start = vi.fn(async () => EMPTY)
    const forced = coordinator.run({ key: 'scope', force: true, start })
    const interest = scanRecoveryInterest(signal)
    if (interest) {
      interest.observation = nextScanObservationOrder()
    }
    scan.resolve(EMPTY)
    await expect(Promise.all([first, forced])).resolves.toEqual([EMPTY, EMPTY])
    expect(start).not.toHaveBeenCalled()
  })
})

it('keeps a shared observer subscribed until its final owner detaches', async () => {
  const coordinator = new AiVaultScanCoordinator()
  const scan = deferred<typeof EMPTY>()
  let publish!: Parameters<Parameters<typeof coordinator.run>[0]['start']>[2]
  const start = vi.fn((_signal, _id, emit) => {
    publish = emit
    return scan.promise
  })
  const observer = vi.fn()
  const owner = new AbortController()
  const first = coordinator.run({ key: 'same', start, observeRows: observer, signal: owner.signal })
  const second = coordinator.run({ key: 'same', start, observeRows: observer })
  await Promise.resolve()
  owner.abort()
  await expect(first).rejects.toMatchObject({ name: 'AbortError' })
  publish({ upserts: [], removed: ['gone'] })
  expect(observer).toHaveBeenCalledTimes(1)
  scan.resolve(EMPTY)
  await second
})

it('runs a fresh pass for a force that arrives after a recovered successor began observing', async () => {
  const coordinator = new AiVaultScanCoordinator()
  const leading = deferred<typeof EMPTY>()
  let signal!: AbortSignal
  const first = coordinator.run({
    key: 'scope',
    start: (value) => {
      signal = value
      return leading.promise
    }
  })
  await Promise.resolve()
  const fresh = { ...EMPTY, scannedAt: 'after-late-force' }
  const start = vi.fn(async () => fresh)
  const forceBeforeRecovery = coordinator.run({ key: 'scope', force: true, start })
  const interest = scanRecoveryInterest(signal)
  if (interest) {
    interest.observation = nextScanObservationOrder()
  }
  const forceAfterRecovery = coordinator.run({ key: 'scope', force: true, start })
  leading.resolve(EMPTY)
  await expect(first).resolves.toBe(EMPTY)
  await expect(Promise.all([forceBeforeRecovery, forceAfterRecovery])).resolves.toEqual([
    fresh,
    fresh
  ])
  expect(start).toHaveBeenCalledOnce()
})
