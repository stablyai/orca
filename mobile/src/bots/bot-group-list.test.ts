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
  it("keeps the listed preview and place when the save's plain record arrives", () => {
    const listed = group({ latest: { authorName: null, text: 'hi', at: 1 }, sidebarOrder: 3 })
    const [merged] = withSavedGroup([listed], group({ name: 'Crew two', revision: 3 }))
    expect(merged).toMatchObject({ name: 'Crew two', sidebarOrder: 3, latest: { text: 'hi' } })
  })

  it('keeps a newer revision the change event listed first', () => {
    const listed = group({ revision: 4, name: 'Newer' })
    expect(withSavedGroup([listed], group({ revision: 3 }))[0]?.name).toBe('Newer')
  })
})
