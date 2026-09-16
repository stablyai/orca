import { describe, expect, it } from 'vitest'
import { generateId } from './db/generated-id'
import { parseOrchestrationTaskDepsFlag } from './task-deps-flag'

describe('parseOrchestrationTaskDepsFlag', () => {
  it('accepts canonical JSON string arrays', () => {
    expect(parseOrchestrationTaskDepsFlag('["task_b2a580db74d8"]')).toEqual(['task_b2a580db74d8'])
    expect(parseOrchestrationTaskDepsFlag('[]')).toEqual([])
  })

  it('recovers quote-stripped generated task IDs', () => {
    expect(parseOrchestrationTaskDepsFlag('[task_b2a580db74d8]')).toEqual(['task_b2a580db74d8'])
    expect(parseOrchestrationTaskDepsFlag('[ task_b2a580db74d8 , task_907c556bfed6 ]')).toEqual([
      'task_b2a580db74d8',
      'task_907c556bfed6'
    ])
  })

  it('rejects valid JSON with the wrong shape without entering argv recovery', () => {
    const recoveryProbe = {
      [Symbol.toPrimitive]: () => '[1]',
      trim: () => {
        throw new Error('argv recovery ran')
      }
    } as unknown as string

    expect(() => parseOrchestrationTaskDepsFlag(recoveryProbe)).toThrow(
      'Invalid --deps: must be a JSON array of task IDs'
    )
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

  it('tracks the generated task ID contract', () => {
    expect(parseOrchestrationTaskDepsFlag(`[${generateId('task')}]`)).toHaveLength(1)
    expect(() => parseOrchestrationTaskDepsFlag('[task_abc]')).toThrow('Invalid --deps')
  })
})

// Why: the recovery grammar used to hardcode 12 hex chars, which silently diverges if generateId's
// byte count changes. This pins the validator to what the generator actually produces.
describe('generated-id contract', () => {
  it('accepts ids the generator produces', () => {
    for (let i = 0; i < 50; i++) {
      expect(parseOrchestrationTaskDepsFlag(`[${generateId('task')}]`)).toHaveLength(1)
    }
  })

  it('still rejects an id of the wrong length', () => {
    expect(() => parseOrchestrationTaskDepsFlag('[task_abc]')).toThrow('Invalid --deps')
  })
})
