import { describe, expect, it } from 'vitest'
import type { VoloBoard, VoloTask } from '../../shared/volo-types'
import { filterTasks } from './tasks'

const board: VoloBoard = {
  id: 'b1',
  name: 'Delivery',
  prefix: 'DD',
  columns: [
    { id: 'todo', name: 'Todo', order: 0, type: 'not_started' },
    { id: 'done', name: 'Done', order: 1, type: 'done' }
  ]
}

function task(partial: Partial<VoloTask> & Pick<VoloTask, 'id' | 'columnId'>): VoloTask {
  return {
    taskCode: partial.id.toUpperCase(),
    title: partial.id,
    url: `https://volo.jaak.ai/t/${partial.id}`,
    boardId: 'b1',
    priority: 'medium',
    inKanban: true,
    order: 0,
    updatedAt: '2026-08-01T00:00:00.000Z',
    createdAt: '2026-08-01T00:00:00.000Z',
    ...partial
  }
}

describe('filterTasks', () => {
  it('keeps open tasks for the all preset and done-column tasks for done', () => {
    const tasks = [task({ id: 'open', columnId: 'todo' }), task({ id: 'closed', columnId: 'done' })]
    expect(filterTasks(tasks, board, 'all', null).map((entry) => entry.id)).toEqual(['open'])
    expect(filterTasks(tasks, board, 'done', null).map((entry) => entry.id)).toEqual(['closed'])
  })

  it('matches assigned tasks by member or user id', () => {
    const tasks = [
      task({ id: 'mine', columnId: 'todo', assigneeId: 'member-1' }),
      task({ id: 'other', columnId: 'todo', assigneeId: 'member-2' })
    ]
    expect(
      filterTasks(tasks, board, 'assigned', 'user-1', [
        { id: 'member-1', userId: 'user-1', name: 'Ada' }
      ]).map((entry) => entry.id)
    ).toEqual(['mine'])
  })
})
