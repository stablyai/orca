import { describe, expect, it } from 'vitest'
import type { BotGroup } from '../../../src/shared/bots/bot-group'
import { withSavedGroup } from './bot-group-list'

const group = (overrides: Partial<BotGroup> = {}): BotGroup => ({
  id: 'g',
  name: 'Crew',
  hostId: 'local',
  revision: 2,
  folder: 'group-crew',
  folderWorkspaceId: 'fw-g',
  createdAt: 1,
  members: [{ botId: 'a', sessionId: 's-a' }],
  replyMode: { kind: 'mentions' },
  ...overrides
})

describe('withSavedGroup', () => {
  it('keeps the listed preview and rejects an older save after a revision updates', () => {
    const listed = group({ latest: { authorName: null, text: 'hi', at: 1 }, sidebarOrder: 3 })
    const updated = withSavedGroup([listed], group({ name: 'Crew two', revision: 3 }))
    expect(updated[0]).toMatchObject({
      name: 'Crew two',
      revision: 3,
      sidebarOrder: 3,
      latest: { text: 'hi' }
    })
    expect(withSavedGroup(updated, group())).toEqual(updated)
  })
})
