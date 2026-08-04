import { describe, expect, it } from 'vitest'

import { parseOrchestrationTaskDepsFlag } from './task-deps-flag'

describe('parseOrchestrationTaskDepsFlag', () => {
  it('accepts a JSON string array of task ids', () => {
    expect(parseOrchestrationTaskDepsFlag('["task_907c556bfed6"]')).toEqual(['task_907c556bfed6'])
    expect(parseOrchestrationTaskDepsFlag('["task_aa","task_bb"]')).toEqual(['task_aa', 'task_bb'])
    expect(parseOrchestrationTaskDepsFlag('[]')).toEqual([])
  })

  it('recovers the quote-stripped WSL form of a JSON array', () => {
    // Why: PS 5.1 drops " when forwarding native argv, so ["task_x"] becomes [task_x].
    expect(parseOrchestrationTaskDepsFlag('[task_907c556bfed6]')).toEqual(['task_907c556bfed6'])
    expect(parseOrchestrationTaskDepsFlag('[task_aa, task_bb]')).toEqual(['task_aa', 'task_bb'])
  })

  it('accepts a bare task id or CSV list', () => {
    expect(parseOrchestrationTaskDepsFlag('task_907c556bfed6')).toEqual(['task_907c556bfed6'])
    expect(parseOrchestrationTaskDepsFlag('task_aa,task_bb')).toEqual(['task_aa', 'task_bb'])
  })

  it('rejects non-task-id content on both JSON and recovery paths', () => {
    expect(() => parseOrchestrationTaskDepsFlag('not-json')).toThrow('Invalid --deps')
    expect(() => parseOrchestrationTaskDepsFlag('[not_a_task]')).toThrow('Invalid --deps')
    expect(() => parseOrchestrationTaskDepsFlag('["not_a_task"]')).toThrow('Invalid --deps')
    expect(() => parseOrchestrationTaskDepsFlag('[""]')).toThrow('Invalid --deps')
    expect(() => parseOrchestrationTaskDepsFlag('[{"id":"task_aa"}]')).toThrow('Invalid --deps')
  })

  it('rejects empty CSV segments and unbalanced edge quotes', () => {
    expect(() => parseOrchestrationTaskDepsFlag('task_aa,,task_bb')).toThrow('Invalid --deps')
    expect(() => parseOrchestrationTaskDepsFlag('[task_aa,]')).toThrow('Invalid --deps')
    expect(() => parseOrchestrationTaskDepsFlag('"task_aa')).toThrow('Invalid --deps')
  })
})
