import { describe, expect, it } from 'vitest'
import type { BotGroup } from '../../shared/bots/bot-group'
import SyncDatabase from '../sqlite/sync-database'
import { BotGroupStore } from './bot-group-store'

describe('a saved row that is not JSON', () => {
  it('is skipped: the groups beside it still list, and a torn latest drops only the preview', () => {
    const db = new SyncDatabase(':memory:')
    const store = new BotGroupStore(db)
    db.prepare('INSERT INTO bot_groups(id, record) VALUES (?, ?)').run('torn', '{"id":')
    const group: BotGroup = {
      id: 'room-1',
      name: 'Release',
      hostId: 'local',
      revision: 1,
      folder: '/work/release',
      folderWorkspaceId: 'folder:release',
      createdAt: 0,
      members: [],
      replyMode: { kind: 'all' }
    }
    store.put(group)
    db.prepare(
      'INSERT INTO bot_group_sidebar(group_id, sidebar_order, latest) VALUES (?, ?, ?)'
    ).run(group.id, 3, '{"text":')

    expect(store.list()).toEqual([group])
    expect(store.listing()).toEqual([{ ...group, sidebarOrder: 3 }])
  })
})
