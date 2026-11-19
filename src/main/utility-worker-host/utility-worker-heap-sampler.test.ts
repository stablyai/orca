import { expect, it } from 'vitest'
import { utilityWorkerHeapReportChanged } from './utility-worker-heap-sampler'

const MB = 2 ** 20
function report(hostMB: number, ...workers: [number, number | null][]) {
  return {
    sampledAt: 0,
    hostBytes: hostMB * MB,
    workers: workers.map(([id, mb]) => ({
      id,
      bytes: mb === null ? null : mb * MB,
      estimated: false
    }))
  }
}

it('posts the first report and real moves, and stays quiet while the heaps hold steady', () => {
  const steady = report(64, [1, 1200], [2, 400])
  expect(utilityWorkerHeapReportChanged(undefined, steady)).toBe(true)
  expect(utilityWorkerHeapReportChanged(steady, report(70, [1, 1210], [2, 410]))).toBe(false)
  // Same total, but the reader holding the memory changed.
  expect(utilityWorkerHeapReportChanged(steady, report(64, [1, 400], [2, 1200]))).toBe(true)
  // A replaced reader is a different isolate even at the same size.
  expect(utilityWorkerHeapReportChanged(steady, report(64, [1, 1200], [3, 400]))).toBe(true)
  expect(utilityWorkerHeapReportChanged(steady, report(64, [1, 1200], [2, null]))).toBe(true)
  // Crossing the breadcrumb mark is reported even when nothing moved 64 MB.
  const below = report(64, [1, 1000], [2, 450])
  expect(utilityWorkerHeapReportChanged(below, report(64, [1, 1000], [2, 480]))).toBe(true)
})
