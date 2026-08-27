import { describe, expect, it, vi } from 'vitest'
import { createKanbanApi, type KanbanApi } from './kanban-api'
import type { PreloadApi } from '../api-types'

describe('kanban preload API', () => {
  it('exposes exactly the five declared operations under window.api.kanban', () => {
    const api = createKanbanApi({ invoke: vi.fn() } as never)

    expect(Object.keys(api).sort()).toEqual([
      'connect',
      'disconnect',
      'getTask',
      'listTasks',
      'status'
    ])

    // Why: the preload factory must stay shape-identical to the declared
    // surface so the renderer never sees extra or missing operations.
    const declared: KanbanApi = api
    const preloadSurface: PreloadApi['kanban'] = declared
    expect(preloadSurface).toBe(api)
  })

  it('invokes the exact kanban:* channels with normalized args', async () => {
    const invoke = vi.fn().mockResolvedValue(undefined)
    const api = createKanbanApi({ invoke } as never)

    await api.connect({ token: 'token-secret' })
    await api.disconnect()
    await api.status()
    await api.listTasks({ filter: { role: 'executor', due: 'today', urgent: true } })
    await api.getTask({ id: 'K-1' })

    expect(invoke.mock.calls).toEqual([
      ['kanban:connect', { token: 'token-secret' }],
      ['kanban:disconnect'],
      ['kanban:status'],
      ['kanban:listTasks', { filter: { role: 'executor', due: 'today', urgent: true } }],
      ['kanban:getTask', { id: 'K-1' }]
    ])
  })

  it('does not invoke any non-kanban channel', async () => {
    const invoke = vi.fn().mockResolvedValue(undefined)
    const api = createKanbanApi({ invoke } as never)

    await api.listTasks()

    for (const call of invoke.mock.calls) {
      expect(call[0]).toMatch(/^kanban:/)
    }
  })
})
