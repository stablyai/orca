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
  it('maps the current server REST contract without exposing its wire-only fields', () => {
    expect(
      mapKanbanViewer({
        user: { user_id: 'user-1', name: 'Ada', platform_role: 'admin' },
        csrf: 'csrf-secret'
      })
    ).toEqual({ ok: true, value: { id: 'user-1', name: 'Ada', level: 'admin' } })

    const list = mapKanbanTaskList({
      schema: 2,
      version: 1,
      lanes: ['Backlog', 'In progress'],
      users: [
        { id: 'user-1', name: 'Ada' },
        { id: 'user-2', name: 'Grace' }
      ],
      tasks: [
        {
          id: 'K 1',
          t: 'Fix login',
          lane: 'In progress',
          task_version: 5,
          created_by: 'user-1',
          executors: ['user-1'],
          observers: ['user-2'],
          due: '',
          hot: 1,
          tag: 'security',
          blocked_by: 'K-0',
          src: '',
          gh: ''
        }
      ]
    })

    expect(list.ok).toBe(true)
    if (!list.ok) {
      return
    }
    expect(list.value.tasks).toEqual([
      {
        id: 'K 1',
        title: 'Fix login',
        laneId: 'In progress',
        laneName: 'In progress',
        due: null,
        urgent: true,
        repositoryUrls: [],
        taskVersion: 5,
        executors: [{ id: 'user-1', name: 'Ada' }],
        observers: [{ id: 'user-2', name: 'Grace' }],
        createdBy: { id: 'user-1', name: 'Ada' },
        url: 'https://kanban.fpimi.ru/?task=K%201'
      }
    ])
    expect(list.value.lanes).toEqual([
      { id: 'Backlog', name: 'Backlog' },
      { id: 'In progress', name: 'In progress' }
    ])

    const detail = mapKanbanTaskDetails(
      {
        task: {
          id: 'K 1',
          t: 'Fix login',
          lane: 'In progress',
          task_version: 5,
          created_by: 'user-1',
          executors: ['user-1'],
          observers: ['user-2'],
          due: '',
          hot: 0,
          tag: '',
          blocked_by: '',
          src: '',
          gh: '',
          c: [
            {
              ts: '2026-08-27T09:00:00Z',
              author_id: 'user-2',
              a: 'comment',
              m: 'Please add tests',
              channel: 'web'
            }
          ],
          attachments: [{ id: 'log / 1', name: 'log.txt', size: 12, mime: 'text/plain' }],
          subtasks: [{ id: 's-1', t: 'Update docs', executor_id: 'user-1', done: false }]
        }
      },
      list.value.context
    )

    expect(detail.ok).toBe(true)
    if (!detail.ok) {
      return
    }
    expect(detail.value).toMatchObject({
      due: null,
      urgent: false,
      tags: [],
      blockedBy: [],
      source: null,
      comments: [
        {
          author: { id: 'user-2', name: 'Grace' },
          text: 'Please add tests',
          createdAt: '2026-08-27T09:00:00Z'
        }
      ],
      attachments: [
        {
          name: 'log.txt',
          size: 12,
          url: 'https://kanban.fpimi.ru/api/tasks/K%201/attachments/log%20%2F%201'
        }
      ],
      subtasks: [{ id: 's-1', title: 'Update docs', done: false }]
    })
    expect(detail.value.comments[0]?.id).toBe('comment-5150dbc4b7631803')
  })

  it('rejects malformed current-contract fields and unresolved user ids', () => {
    expectInvalid(
      mapKanbanTaskList({
        lanes: ['Backlog'],
        users: [{ id: 'user-1', name: 'Ada' }],
        tasks: [
          {
            id: 'K-1',
            t: 'Bad executor',
            lane: 'Backlog',
            task_version: 1,
            executors: ['missing-user']
          }
        ]
      })
    )
    expectInvalid(
      mapKanbanTaskList({
        lanes: ['Backlog'],
        users: 'not-an-array',
        tasks: [{ id: 'K-1', t: 'Bad users', lane: 'Backlog', task_version: 1 }]
      })
    )
    expectInvalid(
      mapKanbanTaskList({
        lanes: ['Backlog'],
        users: [],
        tasks: [{ id: 'K-1', t: 'Bad hot', lane: 'Backlog', task_version: 1, hot: 2 }]
      })
    )
    expectInvalid(mapKanbanTaskList({ schema: [], version: 1, lanes: [], users: [], tasks: [] }))
  })

  it('maps historical comment authors and unassigned subtasks without relaxing role ids', () => {
    const context = mapKanbanTaskList({
      schema: 2,
      version: 1,
      lanes: ['Backlog'],
      users: [{ id: 'active-user', name: 'Ada' }],
      tasks: []
    })
    expect(context.ok).toBe(true)
    if (!context.ok) {
      return
    }

    const detail = mapKanbanTaskDetails(
      {
        task: {
          id: 'K-archive',
          t: 'Historical task',
          lane: 'Backlog',
          task_version: 1,
          created_by: 'inactive-creator',
          c: [
            {
              ts: '2025-01-02T03:04:05Z',
              author_id: 'inactive-user',
              a: 'Former User',
              m: 'Historical comment',
              channel: 'web'
            },
            {
              ts: '2024-01-02T03:04:05Z',
              author_id: '',
              a: 'Imported User',
              m: 'Imported comment',
              channel: 'import'
            }
          ],
          subtasks: [{ id: 's-unassigned', t: 'Pick owner', executor_id: '', done: false }]
        }
      },
      context.value.context
    )
    expect(detail.ok).toBe(true)
    if (!detail.ok) {
      return
    }
    expect(detail.value.comments[0]?.author).toEqual({
      id: 'inactive-user',
      name: 'Former User'
    })
    expect(detail.value.comments[1]?.author).toEqual({
      id: 'comment-author-5f494dc424de9e2e',
      name: 'Imported User'
    })
    expect(detail.value.createdBy).toEqual({
      id: 'inactive-creator',
      name: 'inactive-creator'
    })
    expect(detail.value.subtasks).toEqual([
      { id: 's-unassigned', title: 'Pick owner', done: false }
    ])

    expectInvalid(
      mapKanbanTaskDetails(
        {
          task: {
            id: 'K-bad-subtask',
            t: 'Bad subtask',
            lane: 'Backlog',
            task_version: 1,
            subtasks: [
              { id: 's-missing', t: 'Missing owner', executor_id: 'missing-user', done: false }
            ]
          }
        },
        context.value.context
      )
    )
  })

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
      value: expect.objectContaining({
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
      })
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

  it('rejects an attachment whose size is present but not a finite number', () => {
    expectInvalid(
      mapKanbanTaskDetails({
        id: 'K-11',
        t: 'Bad attachment size',
        lane: { id: 'L-5', name: 'Backlog' },
        task_version: 1,
        attachments: [{ name: 'log.txt', url: 'https://example.com/log.txt', size: 'oops' }]
      })
    )
    expectInvalid(
      mapKanbanTaskDetails({
        id: 'K-12',
        t: 'Non-finite attachment size',
        lane: { id: 'L-5', name: 'Backlog' },
        task_version: 1,
        attachments: [
          { name: 'log.txt', url: 'https://example.com/log.txt', size: Number.POSITIVE_INFINITY }
        ]
      })
    )
  })

  it('keeps an absent attachment size acceptable', () => {
    const result = mapKanbanTaskDetails({
      id: 'K-13',
      t: 'Missing attachment size',
      lane: { id: 'L-5', name: 'Backlog' },
      task_version: 1,
      attachments: [{ name: 'log.txt', url: 'https://example.com/log.txt' }]
    })
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.value.attachments).toEqual([
      { name: 'log.txt', url: 'https://example.com/log.txt', size: null }
    ])
  })

  it('rejects a subtask with a non-boolean or missing done', () => {
    expectInvalid(
      mapKanbanTaskDetails({
        id: 'K-14',
        t: 'Bad subtask done',
        lane: { id: 'L-5', name: 'Backlog' },
        task_version: 1,
        subtasks: [{ id: 's-1', title: 'Update docs', done: 'yes' }]
      })
    )
    expectInvalid(
      mapKanbanTaskDetails({
        id: 'K-15',
        t: 'Missing subtask done',
        lane: { id: 'L-5', name: 'Backlog' },
        task_version: 1,
        subtasks: [{ id: 's-2', title: 'Update docs' }]
      })
    )
  })

  it('keeps a boolean subtask done acceptable', () => {
    const result = mapKanbanTaskDetails({
      id: 'K-16',
      t: 'Boolean subtask done',
      lane: { id: 'L-5', name: 'Backlog' },
      task_version: 1,
      subtasks: [
        { id: 's-1', title: 'Update docs', done: true },
        { id: 's-2', title: 'Write tests', done: false }
      ]
    })
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.value.subtasks).toEqual([
      { id: 's-1', title: 'Update docs', done: true },
      { id: 's-2', title: 'Write tests', done: false }
    ])
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
