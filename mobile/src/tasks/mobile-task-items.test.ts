import { describe, expect, it } from 'vitest'
import { createClickUpTask, taskExternalOpenLabel, taskKindLabel } from './mobile-task-items'

describe('mobile ClickUp task items', () => {
  it('maps ClickUp identity, List, status, and external actions', () => {
    const item = createClickUpTask({
      id: '86abc123',
      customId: 'CU-42',
      workspaceId: 'team-1',
      workspaceName: 'Product',
      name: 'Ship mobile parity',
      url: 'https://app.clickup.com/t/86abc123',
      status: { name: 'in progress', color: '#123456', type: 'custom', orderIndex: 2 },
      assignees: [],
      tags: [],
      list: { id: 'list-1', name: 'Mobile' },
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-02T00:00:00.000Z'
    })

    expect(item).toMatchObject({
      key: 'clickup:team-1:86abc123',
      provider: 'clickup',
      title: 'Ship mobile parity',
      subtitle: 'CU-42 · Mobile',
      status: 'in progress'
    })
    expect(taskKindLabel(item)).toBe('ClickUp task')
    expect(taskExternalOpenLabel(item)).toBe('Open in ClickUp')
  })
})
