import type { HeapProfiler } from 'node:inspector'
import { expect, it } from 'vitest'
import { approxBytes, summarizeAllocationProfile } from './main-allocation-sampler'

it('keeps only function names and script basenames in allocation stacks', () => {
  const frame = (
    mb: number,
    functionName: string,
    url: string,
    children: HeapProfiler.SamplingHeapProfileNode[] = []
  ): HeapProfiler.SamplingHeapProfileNode => ({
    selfSize: mb * 1024 * 1024,
    callFrame: { functionName, url, scriptId: '1', lineNumber: 9, columnNumber: 0 },
    children
  })
  const head = frame(0, '(root)', '', [
    frame(1, 'saveSession', 'file:///Users/alice/Apps/Orca.app/out/main/index.js', [
      frame(2, 'client acme', 'C:\\Users\\alice\\AppData\\Orca\\out\\main\\index.js?x=1'),
      frame(3, '/home/alice/notes/key', '/home/alice/notes/alice plan.js')
    ])
  ])
  const details = summarizeAllocationProfile(head)
  expect(details).toEqual({
    allocationSampledMB: 6,
    alloc_1_kb: 3072,
    alloc_1_stack: '(unnamed) ?:10 < saveSession index.js:10',
    alloc_2_kb: 2048,
    alloc_2_stack: '(unnamed) index.js:10 < saveSession index.js:10',
    alloc_3_kb: 1024,
    alloc_3_stack: 'saveSession index.js:10'
  })
  expect(JSON.stringify(details)).not.toContain('alice')
})

it('sizes arrays within the visit budget without running their getters', () => {
  let reads = 0
  const payload: unknown[] = [
    new Uint8Array(1024 * 1024),
    0,
    ...Array.from({ length: 1998 }, () => 1)
  ]
  Object.defineProperty(payload, 1, { enumerable: true, get: () => ++reads })
  expect(approxBytes(payload)).toBe(1024 * 1024 + 1998 * 8)
  expect(reads).toBe(0)
})
