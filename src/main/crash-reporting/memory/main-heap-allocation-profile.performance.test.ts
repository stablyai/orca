import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const inspector = vi.hoisted(() => ({ profileReads: 0 }))

vi.mock('node:inspector', () => ({
  Session: class {
    connect(): void {}
    disconnect(): void {}
    post(method: string, _params: unknown, callback: (error: null, result: unknown) => void): void {
      if (method === 'HeapProfiler.getSamplingProfile') {
        inspector.profileReads += 1
        callback(null, { profile: { head: { callFrame: {}, selfSize: 0, children: [] } } })
        return
      }
      callback(null, {})
    }
  }
}))
vi.mock('electron', () => ({
  crashReporter: { addExtraParameter: vi.fn(), removeExtraParameter: vi.fn() }
}))
vi.mock('../breadcrumbs/durable-crash-breadcrumb', () => ({
  recordDurableCrashBreadcrumb: vi.fn()
}))
vi.mock('../../worker-threads/worker-thread-entry-path', () => ({
  currentWorkerEntryLayout: () => ({ moduleDir: '/app/out/main' })
}))

const GB = 2 ** 30

// Guards #44881: reads start at 1.5 GB, and each forces a full GC on main, so a heap that keeps
// crossing that line must not pay for one every time.
describe('main heap allocation profile reads', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.resetModules()
    inspector.profileReads = 0
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  async function heapAt(
    note: (total: number, main: number) => void,
    totalGB: number
  ): Promise<void> {
    note(totalGB * GB, totalGB * GB)
    // Sampling becomes ready after its enable/start round trip.
    await vi.advanceTimersByTimeAsync(0)
  }

  it('reads a heap that peaks past 1.5 GB every minute for two hours four times', async () => {
    const { noteMainCageHeap } = await import('./main-heap-allocation-profile')

    for (let minute = 0; minute < 120; minute++) {
      await heapAt(noteMainCageHeap, 1.6)
      await heapAt(noteMainCageHeap, 1.6)
      await heapAt(noteMainCageHeap, 0.7)
      await vi.advanceTimersByTimeAsync(60_000)
    }

    expect(inspector.profileReads).toBe(4)
  })

  it('still reads near the cage limit right after an early read', async () => {
    const { noteMainCageHeap } = await import('./main-heap-allocation-profile')

    await heapAt(noteMainCageHeap, 1.6)
    await heapAt(noteMainCageHeap, 1.6)
    await heapAt(noteMainCageHeap, 2.6)

    expect(inspector.profileReads).toBe(2)
  })
})
