import { describe, expect, it } from 'vitest'

import { parseOrchestrationTaskDepsFlag } from './task-deps-flag'

describe('parseOrchestrationTaskDepsFlag', () => {
  it('accepts a JSON string array of task ids', () => {
    expect(parseOrchestrationTaskDepsFlag('["task_907c556bfed6"]')).toEqual(['task_907c556bfed6'])
    expect(parseOrchestrationTaskDepsFlag('["task_aa","task_bb"]')).toEqual(['task_aa', 'task_bb'])
    expect(parseOrchestrationTaskDepsFlag('[]')).toEqual([])
  })

  it('recovers the quote-stripped WSL form of a JSON array', () => {
    expect(parseOrchestrationTaskDepsFlag('[task_907c556bfed6]')).toEqual(['task_907c556bfed6'])
    expect(parseOrchestrationTaskDepsFlag('[task_aa, task_bb]')).toEqual(['task_aa', 'task_bb'])
  })

  it('rejects invalid JSON and non-task-id recovery content', () => {
    expect(() => parseOrchestrationTaskDepsFlag('not-json')).toThrow('Invalid --deps')
    expect(() => parseOrchestrationTaskDepsFlag('task_aa')).toThrow('Invalid --deps')
    expect(() => parseOrchestrationTaskDepsFlag('task_aa,task_bb')).toThrow('Invalid --deps')
    expect(() => parseOrchestrationTaskDepsFlag('[not_a_task]')).toThrow('Invalid --deps')
    expect(() => parseOrchestrationTaskDepsFlag('[{"id":"task_aa"}]')).toThrow('Invalid --deps')
  })

  it('rejects malformed quote-stripped arrays', () => {
    expect(() => parseOrchestrationTaskDepsFlag('[task_aa,,task_bb]')).toThrow('Invalid --deps')
    expect(() => parseOrchestrationTaskDepsFlag('[task_aa,]')).toThrow('Invalid --deps')
    expect(() => parseOrchestrationTaskDepsFlag("['task_aa']")).toThrow('Invalid --deps')
  })
})
