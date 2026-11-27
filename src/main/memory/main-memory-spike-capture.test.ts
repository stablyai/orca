import { afterEach, beforeEach, expect, it, vi } from 'vitest'

vi.mock('../worker-threads/worker-thread-diagnostics', () => ({
  readWorkerThreadMemoryData: async () => ({ workers: 0 })
}))

import {
  PRE_GONE_SYSTEM_MEMORY_SAMPLE_INTERVAL_MS,
  samplePreGoneSystemMemory
} from '../crash-reporting/memory/pre-gone-host-memory'
import { setActiveSink } from '../observability/tracer'
import { resetMainMemorySpikeCaptureForTest } from './main-memory-spike-capture'

type SpanRecord = { name?: string; attributes?: Record<string, unknown> }
const records: SpanRecord[] = []

beforeEach(() => {
  setActiveSink({ push: (record: SpanRecord) => records.push(record), flush() {}, close() {} })
  vi.useFakeTimers({ toFake: ['Date'] })
})

afterEach(() => {
  resetMainMemorySpikeCaptureForTest()
  setActiveSink(null)
  records.length = 0
  vi.useRealTimers()
  Reflect.deleteProperty(process, 'getProcessMemoryInfo')
})

it('catches a footprint spike that lasts about a minute on the host-memory tick', async () => {
  // A reported spike: 693 MB to 1,223 MB of footprint in 63 s, then back down to 908 MB. Starting
  // 5 s before a minute tick, a once-a-minute sampler sees only 735 MB and then 908 MB.
  const riseAt = 10 * 60_000 + 55_000
  const footprintMB = (ms: number): number => {
    if (ms < riseAt) {
      return 693
    }
    return ms <= riseAt + 63_000 ? Math.round(693 + ((ms - riseAt) / 63_000) * 530) : 908
  }
  Object.defineProperty(process, 'getProcessMemoryInfo', {
    value: async () => ({ private: footprintMB(Date.now()) * 1024, shared: 0 }),
    configurable: true
  })
  for (let ms = 0; ms <= 15 * 60_000; ms += PRE_GONE_SYSTEM_MEMORY_SAMPLE_INTERVAL_MS) {
    vi.setSystemTime(ms)
    await samplePreGoneSystemMemory(ms)
    await new Promise((resolve) => setImmediate(resolve))
  }
  await new Promise((resolve) => setImmediate(resolve))
  expect(records.map((record) => record.name)).toEqual(['memory.main-spike'])
  expect(records[0].attributes).toMatchObject({
    baselineFootprintMB: 693,
    baseline_v8UsedHeapMB: expect.any(Number),
    baseline_v8Space_old_space_usedMB: expect.any(Number)
  })
})
