import { describe, expect, it } from 'vitest'
import {
  mapKanbanTaskDetails,
  mapKanbanTaskList,
  mapKanbanViewer,
  type KanbanMapperResult
} from './task-mapping'

function expectInvalid<T>(result: KanbanMapperResult<T>): void {
  expect(result).toEqual({ ok: false, reason: 'invalid_response' })
}

describe('kanban task mapping', () => {
  it('maps a minimal task list with lanes', () => {
    const result = mapKanbanTaskList({
      tasks: [
        {
          id: 'K-1',
          t: 'Fix login',
          lane: 'L-1',
          task_version: 5,
          executors: [{ id: 'user-1', name: 'Ada' }],
          observers: [],
          due: '2026-09-01',
          hot: true
        }
      ],
      lanes: [{ id: 'L-1', name: 'Backlog' }]
    })

    expect(result).toEqual({
      ok: true,
      value: {
        tasks: [
          {
            id: 'K-1',
            title: 'Fix login',
            laneId: 'L-1',
            laneName: 'Backlog',
            due: '2026-09-01',
            urgent: true,
            repositoryUrls: [],
            taskVersion: 5,
            executors: [{ id: 'user-1', name: 'Ada' }],
            observers: [],
            createdBy: null,
            url: 'https://kanban.fpimi.ru/?task=K-1'
          }
        ],
        lanes: [{ id: 'L-1', name: 'Backlog' }]
      }
    })
  })

  it('fills defaults for missing optional fields', () => {
    const result = mapKanbanTaskList({
      tasks: [{ id: 'K-2', t: 'Write docs', lane: 'L-2', task_version: 1 }],
      lanes: [{ id: 'L-2', name: 'Backlog' }]
    })

    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.value.tasks[0]).toMatchObject({
      id: 'K-2',
      title: 'Write docs',
      laneId: 'L-2',
      laneName: 'Backlog',
      due: null,
      urgent: false,
      repositoryUrls: [],
      taskVersion: 1,
      executors: [],
      observers: [],
      createdBy: null,
      url: 'https://kanban.fpimi.ru/?task=K-2'
    })
  })

  it('reads multiple repository URLs from repo and gh', () => {
    const result = mapKanbanTaskList({
      tasks: [
        {
          id: 'K-3',
          t: 'Ship deploy',
          lane: 'L-3',
          task_version: 2,
          repo: ['https://example.com/a.git', 'https://example.com/b.git'],
          gh: 'https://github.com/org/repo'
        }
      ],
      lanes: [{ id: 'L-3', name: 'Review' }]
    })

    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.value.tasks[0].repositoryUrls).toEqual([
      'https://example.com/a.git',
      'https://example.com/b.git',
      'https://github.com/org/repo'
    ])
  })

  it('maps comments, description, tags, source and dependencies in details', () => {
    const result = mapKanbanTaskDetails({
      id: 'K-4',
      t: 'Refactor auth',
      lane: { id: 'L-4', name: 'In progress' },
      task_version: 3,
      result: 'Done',
      d: 'Long description',
      tag: ['security', 'refactor'],
      src: 'https://github.com/org/repo',
      blocked_by: ['K-1', 'K-2'],
      created_by: { id: 'user-1', name: 'Ada' },
      c: [
        {
          id: 'c-1',
          author: { id: 'user-2', name: 'Grace' },
          text: 'Please add tests',
          created_at: '2026-08-01T10:00:00Z'
        }
      ],
      attachments: [{ name: 'log.txt', url: 'https://example.com/log.txt', size: 1024 }],
      subtasks: [{ id: 's-1', title: 'Update docs', done: false }]
    })

    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    const task = result.value
    expect(task).toMatchObject({
      id: 'K-4',
      laneId: 'L-4',
      laneName: 'In progress',
      result: 'Done',
      description: 'Long description',
      tags: ['security', 'refactor'],
      source: 'https://github.com/org/repo',
      blockedBy: ['K-1', 'K-2'],
      createdBy: { id: 'user-1', name: 'Ada' }
    })
    expect(task.comments).toEqual([
      {
        id: 'c-1',
        author: { id: 'user-2', name: 'Grace' },
        text: 'Please add tests',
        createdAt: '2026-08-01T10:00:00Z'
      }
    ])
    expect(task.attachments).toEqual([
      { name: 'log.txt', url: 'https://example.com/log.txt', size: 1024 }
    ])
    expect(task.subtasks).toEqual([{ id: 's-1', title: 'Update docs', done: false }])
  })

  it('rejects an invalid task_version', () => {
    expectInvalid(
      mapKanbanTaskList({
        tasks: [{ id: 'K-5', t: 'Bad version', lane: 'L-5', task_version: 'not-a-number' }],
        lanes: [{ id: 'L-5', name: 'Backlog' }]
      })
    )
    expectInvalid(
      mapKanbanTaskList({
        tasks: [{ id: 'K-5', t: 'Missing version', lane: 'L-5' }],
        lanes: [{ id: 'L-5', name: 'Backlog' }]
      })
    )
  })

  it('rejects a task referencing an unknown lane id', () => {
    expectInvalid(
      mapKanbanTaskList({
        tasks: [{ id: 'K-6', t: 'Unknown lane', lane: 'L-missing', task_version: 1 }],
        lanes: [{ id: 'L-5', name: 'Backlog' }]
      })
    )
  })

  it('rejects malformed required fields', () => {
    expectInvalid(
      mapKanbanTaskList({
        tasks: [{ t: 'No id', lane: 'L-5', task_version: 1 }],
        lanes: [{ id: 'L-5', name: 'Backlog' }]
      })
    )
    expectInvalid(
      mapKanbanTaskDetails({
        id: 'K-7',
        t: '',
        lane: { id: 'L-5', name: 'Backlog' },
        task_version: 1
      })
    )
    expectInvalid(
      mapKanbanTaskList({
        tasks: [{ id: 'K-8', t: 'X', lane: 'L-5', task_version: 1, executors: 'nope' }],
        lanes: []
      })
    )
  })

  it('maps a valid viewer and rejects a malformed one', () => {
    expect(mapKanbanViewer({ id: 'user-1', name: 'Ada', level: 'admin' })).toEqual({
      ok: true,
      value: { id: 'user-1', name: 'Ada', level: 'admin' }
    })
    expectInvalid(mapKanbanViewer({ id: '', name: 'Ada', level: 'admin' }))
    expectInvalid(mapKanbanViewer({ id: 'user-1', name: 'Ada' }))
    expectInvalid(mapKanbanViewer({ id: 'user-1', name: 'Ada', level: 42 }))
  })

  it('accepts an inline lane object in a task detail', () => {
    const result = mapKanbanTaskDetails({
      id: 'K-9',
      t: 'Inline lane',
      lane: { id: 'L-9', name: 'Backlog' },
      task_version: 1
    })
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.value.laneName).toBe('Backlog')
  })

  it('encodes special characters in the task deep link', () => {
    const result = mapKanbanTaskDetails({
      id: 'K 10/&?',
      t: 'Odd id',
      lane: { id: 'L-10', name: 'Backlog' },
      task_version: 1
    })
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.value.url).toBe('https://kanban.fpimi.ru/?task=K%2010%2F%26%3F')
  })
})
