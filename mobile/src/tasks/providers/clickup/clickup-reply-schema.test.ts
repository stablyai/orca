import { describe, expect, it } from 'vitest'
import { clickUpTaskPageSchema } from './clickup-reply-schema'

const row = {
  id: 'abc123',
  customId: null,
  name: 'Fix the login redirect',
  descriptionMarkdown: 'Steps to **reproduce**',
  status: { name: 'in review', color: '#a875ff', type: 'custom', orderIndex: 2 },
  priority: { id: '2', label: 'high', color: '#ffcc00' },
  assignees: [{ id: '7', username: 'Ada', email: 'ada@example.com' }],
  creator: null,
  tags: ['bug'],
  url: 'https://app.clickup.com/t/abc123',
  createdAt: '2026-11-01T10:00:00.000Z',
  updatedAt: '2026-11-02T10:00:00.000Z',
  dueAt: null,
  list: { id: 'l1', name: 'Sprint' },
  folder: { id: 'f1', name: 'Engineering' },
  spaceId: 's1',
  workspaceId: 'w1',
  parentId: null
}

describe('clickUpTaskPageSchema', () => {
  it('reads a page and where the next one starts', () => {
    const page = clickUpTaskPageSchema.parse({ tasks: [row], nextPage: 1 })
    expect(page.nextPage).toBe(1)
    expect(page.tasks[0]).toMatchObject({ id: 'abc123', list: { name: 'Sprint' }, tags: ['bug'] })
  })

  it('treats a missing nextPage as the last page', () => {
    expect(clickUpTaskPageSchema.parse({ tasks: [row] }).nextPage).toBeNull()
  })

  it('salvages optional fields an older host omits and drops rows without an identity', () => {
    const sparse = {
      id: 'z9',
      name: 'Sparse',
      status: { name: 'open' },
      url: 'https://app.clickup.com/t/z9',
      updatedAt: '2026-11-02T10:00:00.000Z',
      list: { id: 'l1', name: 'Sprint' }
    }
    const page = clickUpTaskPageSchema.parse({ tasks: [sparse, { name: 'No id' }], nextPage: null })
    expect(page.tasks).toHaveLength(1)
    expect(page.tasks[0]).toMatchObject({
      id: 'z9',
      descriptionMarkdown: '',
      assignees: [],
      tags: [],
      priority: null,
      dueAt: null,
      folder: null,
      status: { name: 'open', type: 'custom', orderIndex: 0, color: '' }
    })
  })
})
