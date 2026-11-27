import { expect, it } from 'vitest'
import { summarizeAllocationProfile } from './main-allocation-sampler'

it('keeps only function names and script basenames in allocation stacks', () => {
  const frame = (id: number, functionName: string, url: string, children: unknown[] = []) => ({
    id,
    selfSize: id * 1024 * 1024,
    callFrame: { functionName, url, lineNumber: 9 },
    children
  })
  const head = frame(0, '(root)', '', [
    frame(1, 'saveSession', 'file:///Users/alice/Apps/Orca.app/out/main/index.js', [
      frame(2, 'stringify', 'C:\\Users\\alice\\AppData\\Orca\\out\\main\\index.js?x=1'),
      frame(3, '', '/home/alice/notes/alice plan.js')
    ])
  ])
  const details = summarizeAllocationProfile(head as never)
  expect(details).toEqual({
    allocationSampledMB: 6,
    alloc_1_kb: 3072,
    alloc_1_stack: '(anonymous) ?:10 < saveSession index.js:10',
    alloc_2_kb: 2048,
    alloc_2_stack: 'stringify index.js:10 < saveSession index.js:10',
    alloc_3_kb: 1024,
    alloc_3_stack: 'saveSession index.js:10'
  })
  expect(JSON.stringify(details)).not.toContain('alice')
})
