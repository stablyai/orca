import { describe, expect, it } from 'vitest'
import {
  flattenCrossBoardKanban,
  mapVoloBoard,
  mapVoloMember,
  mapVoloTask,
  mapVoloViewer
} from './mapping'

describe('volo mapping', () => {
  it('maps a board with ordered columns', () => {
    const board = mapVoloBoard({
      id: 'b1',
      name: 'Delivery',
      prefix: 'DD',
      columns: [
        { id: 'c2', name: 'Done', order: 2, type: 'done' },
        { id: 'c1', name: 'Todo', order: 0, type: 'not_started' }
      ]
    })
    expect(board?.prefix).toBe('DD')
    expect(board?.columns.map((column) => column.id)).toEqual(['c1', 'c2'])
  })

  it('maps a task onto its board column and web URL', () => {
    const board = mapVoloBoard({
      id: 'b1',
      name: 'Delivery',
      prefix: 'DD',
      columns: [{ id: 'todo', name: 'Todo', order: 0, type: 'not_started' }]
    })
    if (!board) {
      throw new Error('expected board')
    }
    const task = mapVoloTask(
      {
        id: 't1',
        taskCode: 'DD-1',
        title: 'Wire Volo',
        columnId: 'todo',
        boardId: 'b1',
        priority: 'high',
        inKanban: true,
        createdAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-02T00:00:00.000Z'
      },
      board,
      'https://volo.jaak.ai',
      new Map()
    )
    expect(task).toMatchObject({
      taskCode: 'DD-1',
      columnName: 'Todo',
      url: 'https://volo.jaak.ai/t/DD-1',
      priority: 'high'
    })
  })

  it('maps /me payloads including avatar', () => {
    expect(
      mapVoloViewer(
        { id: 'u1', name: 'Ada', email: 'ada@jaak.ai', avatar: 'https://img/ada.png' },
        'fallback'
      )
    ).toEqual({
      id: 'u1',
      displayName: 'Ada',
      email: 'ada@jaak.ai',
      avatarUrl: 'https://img/ada.png'
    })
  })

  it('treats missing inKanban as backlog, matching Volo docToTask', () => {
    const board = mapVoloBoard({
      id: 'b1',
      name: 'Delivery',
      prefix: 'DD',
      columns: [{ id: 'todo', name: 'Todo', order: 0, type: 'not_started' }]
    })
    if (!board) {
      throw new Error('expected board')
    }
    const missing = mapVoloTask(
      {
        id: 't1',
        taskCode: 'DD-1',
        title: 'Backlog item',
        columnId: 'todo',
        createdAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-01T00:00:00.000Z'
      },
      board,
      'https://volo.jaak.ai',
      new Map()
    )
    expect(missing?.inKanban).toBe(false)
    const explicit = mapVoloTask(
      {
        id: 't2',
        taskCode: 'DD-2',
        title: 'Kanban item',
        columnId: 'todo',
        inKanban: true,
        createdAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-01T00:00:00.000Z'
      },
      board,
      'https://volo.jaak.ai',
      new Map()
    )
    expect(explicit?.inKanban).toBe(true)
  })

  it('maps flattened member DTOs including avatar', () => {
    expect(
      mapVoloMember({
        id: 'm1',
        userId: 'u1',
        name: 'Ada',
        email: 'ada@jaak.ai',
        avatar: 'https://img/ada.png',
        role: 'member'
      })
    ).toEqual({
      id: 'm1',
      userId: 'u1',
      name: 'Ada',
      email: 'ada@jaak.ai',
      avatarUrl: 'https://img/ada.png'
    })
  })

  it('resolves assignee name when the task stores a member id', () => {
    const board = mapVoloBoard({
      id: 'b1',
      name: 'Delivery',
      prefix: 'DD',
      columns: [{ id: 'todo', name: 'Todo', order: 0, type: 'not_started' }]
    })
    if (!board) {
      throw new Error('expected board')
    }
    const member = mapVoloMember({
      id: 'm1',
      userId: 'u1',
      name: 'Ada',
      email: 'ada@jaak.ai'
    })
    if (!member) {
      throw new Error('expected member')
    }
    const task = mapVoloTask(
      {
        id: 't1',
        taskCode: 'DD-1',
        title: 'Assigned',
        columnId: 'todo',
        assignee: 'm1',
        createdAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-01T00:00:00.000Z'
      },
      board,
      'https://volo.jaak.ai',
      new Map([[member.id, member]])
    )
    expect(task).toMatchObject({ assigneeId: 'm1', assigneeName: 'Ada' })
  })

  it('flattens GET /api/cross-board/kanban into Volo tasks', () => {
    const tasks = flattenCrossBoardKanban(
      {
        columns: [
          {
            type: 'in_progress',
            tasks: [
              {
                taskId: 't1',
                taskCode: 'DD-1',
                title: 'Wire Volo',
                boardId: 'b1',
                boardName: 'Delivery',
                boardPrefix: 'DD',
                columnId: 'doing',
                columnName: 'Doing',
                columnType: 'in_progress',
                priority: 'high',
                assignee: 'm1',
                createdAt: '2026-08-01T00:00:00.000Z',
                updatedAt: '2026-08-02T00:00:00.000Z'
              }
            ]
          }
        ]
      },
      'https://volo.jaak.ai'
    )
    expect(tasks).toEqual([
      expect.objectContaining({
        id: 't1',
        taskCode: 'DD-1',
        url: 'https://volo.jaak.ai/t/DD-1',
        boardName: 'Delivery',
        columnName: 'Doing',
        columnType: 'in_progress',
        assigneeId: 'm1'
      })
    ])
  })
})
