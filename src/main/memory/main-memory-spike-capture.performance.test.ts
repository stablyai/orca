// Main's memory spike capture (#46734, footprint trigger #48847): an idle or steadily growing main writes
// no record and reads no counts, tracing off reads no footprint, and one 300 MB jump writes one record an hour.
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

vi.mock('../worker-threads/worker-thread-diagnostics', () => ({
  readWorkerThreadMemoryData: async () => ({ workers: 0 })
}))

import {
  PRE_GONE_SYSTEM_MEMORY_SAMPLE_INTERVAL_MS,
  samplePreGoneSystemMemory
} from '../crash-reporting/memory/pre-gone-host-memory'
import { setActiveSink } from '../observability/tracer'
import {
  observeMainMemorySample,
  resetMainMemorySpikeCaptureForTest,
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

it('reads no footprint while tracing is off', async () => {
  setActiveSink(null)
  const read = vi.fn(async () => ({ private: 500 * 1024, shared: 0 }))
  Object.defineProperty(process, 'getProcessMemoryInfo', { value: read, configurable: true })
  for (let tick = 0; tick < 360; tick += 1) {
    await samplePreGoneSystemMemory(tick * PRE_GONE_SYSTEM_MEMORY_SAMPLE_INTERVAL_MS)
  }
  expect(read).not.toHaveBeenCalled()
})
