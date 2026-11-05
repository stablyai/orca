import { describe, expect, it } from 'vitest'
import { generateId } from './db/generated-id'
import { parseOrchestrationTaskDepsFlag } from './task-deps-flag'

describe('parseOrchestrationTaskDepsFlag', () => {
  it('recovers quote-stripped generated task IDs', () => {
    expect(parseOrchestrationTaskDepsFlag('[task_b2a580db74d8]')).toEqual(['task_b2a580db74d8'])
    expect(parseOrchestrationTaskDepsFlag('[ task_b2a580db74d8 , task_907c556bfed6 ]')).toEqual([
      'task_b2a580db74d8',
      'task_907c556bfed6'
    ])
  })

  it.each([
    'not-json',
    'task_b2a580db74d8',
    '[task_example]',
    '[not_a_task]',
    '[task_b2a580db74d8,]',
    '[task_b2a580db74d8,,task_907c556bfed6]',
    '[task_b2a580db74d8 task_907c556bfed6]',
    '{"deps":["task_b2a580db74d8"]}',
    '[{"id":"task_b2a580db74d8"}]',
    '[1]'
  ])('rejects unsupported input %s', (raw) => {
    expect(() => parseOrchestrationTaskDepsFlag(raw)).toThrow('Invalid --deps')
  })
})

// Pin recovery grammar to generated ids instead of assuming a fixed hex length.
describe('generated-id contract', () => {
  it('accepts ids the generator produces', () => {
    for (let i = 0; i < 50; i++) {
      expect(parseOrchestrationTaskDepsFlag(`[${generateId('task')}]`)).toHaveLength(1)
    }
  })
})
