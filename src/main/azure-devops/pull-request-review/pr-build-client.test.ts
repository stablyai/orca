import { expect, it } from 'vitest'
import { mapBuildTimeline, tailLogLines } from './pr-build-client'

it('orders build steps, drops checkpoints, keeps log ids and issue messages', () => {
  expect(
    mapBuildTimeline([
      {
        name: 'Test',
        type: 'Task',
        order: 2,
        result: 'failed',
        errorCount: 1,
        log: { id: 9 },
        issues: [{ type: 'error', message: '2 tests failed' }, { type: 'warning' }]
      },
      { name: 'Checkpoint', type: 'Checkpoint', order: 0 },
      { name: 'Build', type: 'Task', order: 1, result: 'succeeded', log: null }
    ])
  ).toEqual([
    {
      name: 'Build',
      type: 'Task',
      state: null,
      result: 'succeeded',
      errorCount: 0,
      logId: null,
      issues: []
    },
    {
      name: 'Test',
      type: 'Task',
      state: null,
      result: 'failed',
      errorCount: 1,
      logId: 9,
      issues: ['error: 2 tests failed']
    }
  ])
  // Orders restart under each job: A's tasks run before B's even with equal orders.
  expect(
    mapBuildTimeline([
      { id: 'b2', parentId: 'B', name: 'B task 2', type: 'Task', order: 2 },
      { id: 'a3', parentId: 'A', name: 'A task 3', type: 'Task', order: 3 },
      { id: 'B', name: 'Job B', type: 'Job', order: 2 },
      { id: 'a2', parentId: 'A', name: 'A task 2', type: 'Task', order: 2 },
      { id: 'A', name: 'Job A', type: 'Job', order: 1 },
      { id: 'b3', parentId: 'B', name: 'B task 3', type: 'Task', order: 3 }
    ]).map((step) => step.name)
  ).toEqual(['Job A', 'A task 2', 'A task 3', 'Job B', 'B task 2', 'B task 3'])
  expect(tailLogLines(['a', 'b', 'c', 'd'], 2)).toEqual(['c', 'd'])
  expect(tailLogLines(['a'], 5)).toEqual(['a'])
})
