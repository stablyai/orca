import { describe, expect, it } from 'vitest'
import type { DetailPayload } from '../../mobile-tasks-provider-detail-types'
import { appendClickUpComment } from './mobile-clickup-task-source'

const detail: DetailPayload = {
  provider: 'clickup',
  taskId: 'task-a',
  description: '',
  comments: [],
  labels: [],
  assignees: [],
  listName: 'Backlog'
}
const comment = { id: 'c1', body: 'Looks good', author: 'You' }

describe('appendClickUpComment', () => {
  it('adds the comment to the detail of the task it was written to', () => {
    expect(appendClickUpComment(detail, 'task-a', comment)).toMatchObject({ comments: [comment] })
  })

  it('leaves another ClickUp task detail untouched when the write finishes after switching', () => {
    expect(appendClickUpComment({ ...detail, taskId: 'task-b' }, 'task-a', comment)).toEqual({
      ...detail,
      taskId: 'task-b'
    })
  })
})
