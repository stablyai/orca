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
  expect(tailLogLines(['a', 'b', 'c', 'd'], 2)).toEqual(['c', 'd'])
  expect(tailLogLines(['a'], 5)).toEqual(['a'])
})
