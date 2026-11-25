// Main's memory spike capture: an idle or steadily growing main writes no record and reads no counts;
// one 300 MB footprint jump within two minutes writes exactly one record an hour.
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

vi.mock('../worker-threads/worker-thread-diagnostics', () => ({
  readWorkerThreadMemoryData: async () => ({ workers: 0 })
}))

import { PRE_GONE_SYSTEM_MEMORY_SAMPLE_INTERVAL_MS } from '../crash-reporting/memory/pre-gone-host-memory'
import { setActiveSink } from '../observability/tracer'
import {
  observeMainMemorySample,
  resetMainMemorySpikeCaptureForTest,
  sampleMainMemoryFootprint,
  setMainMemorySpikeCounts,
  setMainMemorySpikeProcessMetrics
} from './main-memory-spike-capture'

const MINUTE = 60_000
type SpanRecord = { name?: string; attributes?: Record<string, unknown> }
const records: SpanRecord[] = []
const counts = vi.fn(() => ({ openChats: 3, terminals: 2 }))

beforeEach(() => {
  setActiveSink({ push: (record: SpanRecord) => records.push(record), flush() {}, close() {} })
  setMainMemorySpikeCounts(counts)
  setMainMemorySpikeProcessMetrics(() => ({ processMetricsBrowserWorkingSetMB: 700 }))
})

afterEach(() => {
  resetMainMemorySpikeCaptureForTest()
  setActiveSink(null)
  records.length = 0
  counts.mockClear()
  vi.useRealTimers()
  Reflect.deleteProperty(process, 'getProcessMemoryInfo')
})

async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
}

it('does no capture work across a day of samples without a spike', async () => {
  // 20 MB more every minute: 2.9 GB of growth, never 300 MB within two minutes.
  for (let minute = 0; minute < 24 * 60; minute += 1) {
    observeMainMemorySample(500 + minute * 2, minute * MINUTE)
  }
  await settle()
  expect(records).toHaveLength(0)
  expect(counts).not.toHaveBeenCalled()
})

it('ignores the launch ramp', async () => {
  observeMainMemorySample(200, 0)
  observeMainMemorySample(900, MINUTE)
  await settle()
  expect(records).toHaveLength(0)
})

it('compares against the sample from two late-firing ticks ago', async () => {
  observeMainMemorySample(900, 0)
  observeMainMemorySample(1000, 3 * MINUTE)
  observeMainMemorySample(1150, 4 * MINUTE + 1)
  observeMainMemorySample(1300, 5 * MINUTE + 3)
  await settle()
  expect(records).toHaveLength(1)
  expect(records[0].attributes).toMatchObject({
    baselineFootprintMB: 1000,
    baselineAgeMs: 120_003,
    riseMB: 300
  })
})

it('writes one record for a spike and none for another within the hour', async () => {
  observeMainMemorySample(400, 0)
  observeMainMemorySample(850, 3 * MINUTE)
  observeMainMemorySample(860, 4 * MINUTE)
  observeMainMemorySample(1470, 5 * MINUTE)
  observeMainMemorySample(800, 6 * MINUTE)
  observeMainMemorySample(1500, 7 * MINUTE)
  await settle()
  expect(records).toHaveLength(1)
  expect(counts).toHaveBeenCalledTimes(1)
  expect(records[0].name).toBe('memory.main-spike')
  expect(records[0].attributes).toMatchObject({
    mainFootprintMB: 1470,
    baselineFootprintMB: 850,
    riseMB: 620,
    count_openChats: 3,
    count_terminals: 2,
    processMetricsBrowserWorkingSetMB: 700,
    workers: 0
  })

  observeMainMemorySample(800, 66 * MINUTE)
  observeMainMemorySample(1200, 67 * MINUTE)
  await settle()
  expect(records).toHaveLength(2)
})

/** Feeds the footprint curve through the real read path, one read per host-memory tick. */
async function sampleEveryHostMemoryTick(
  untilMs: number,
  footprintMBAt: (ms: number) => number
): Promise<ReturnType<typeof vi.fn>> {
  const read = vi.fn(async () => ({ private: footprintMBAt(Date.now()) * 1024, shared: 0 }))
  Object.defineProperty(process, 'getProcessMemoryInfo', { value: read, configurable: true })
  vi.useFakeTimers({ toFake: ['Date'] })
  for (let ms = 0; ms <= untilMs; ms += PRE_GONE_SYSTEM_MEMORY_SAMPLE_INTERVAL_MS) {
    vi.setSystemTime(ms)
    await sampleMainMemoryFootprint()
  }
  await settle()
  return read
}

it('catches a footprint spike that lasts about a minute', async () => {
  // A reported spike: 693 MB to 1,223 MB of footprint in 63 s, then back down to 908 MB. Starting
  // 5 s before a minute tick, a once-a-minute sampler sees only 735 MB and then 908 MB.
  const riseAt = 10 * MINUTE + 55_000
  await sampleEveryHostMemoryTick(15 * MINUTE, (ms) => {
    if (ms < riseAt) {
      return 693
    }
    return ms <= riseAt + 63_000 ? Math.round(693 + ((ms - riseAt) / 63_000) * 530) : 908
  })
  expect(records).toHaveLength(1)
  expect(records[0].attributes).toMatchObject({ baselineFootprintMB: 693 })
})

it('reads no footprint while tracing is off', async () => {
  setActiveSink(null)
  const read = await sampleEveryHostMemoryTick(60 * MINUTE, () => 500)
  expect(read).not.toHaveBeenCalled()
})
