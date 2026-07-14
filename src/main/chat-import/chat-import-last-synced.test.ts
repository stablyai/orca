import { describe, expect, it } from 'vitest'
import SyncDatabase from '../sqlite/sync-database'
import { initChatImportSchema } from './chat-import-schema'
import { upsertWebConversation } from './chat-import-store'
import { lastSyncedBySource } from './chat-import-last-synced'

function db() {
  const d = new SyncDatabase(':memory:')
  initChatImportSchema(d)
  return d
}

describe('lastSyncedBySource', () => {
  it('returns MAX(synced_at) per source, null for unseen', () => {
    const d = db()
    upsertWebConversation(
      d,
      {
        source: 'CHATGPT',
        externalId: 'a',
        title: 't',
        createdAt: null,
        updatedAt: null,
        messages: []
      },
      '2026-07-01T00:00:00.000Z'
    )
    upsertWebConversation(
      d,
      {
        source: 'CHATGPT',
        externalId: 'b',
        title: 't',
        createdAt: null,
        updatedAt: null,
        messages: []
      },
      '2026-07-05T00:00:00.000Z'
    )
    upsertWebConversation(
      d,
      {
        source: 'GEMINI',
        externalId: 'c',
        title: 't',
        createdAt: null,
        updatedAt: null,
        messages: []
      },
      '2026-07-03T00:00:00.000Z'
    )
    expect(lastSyncedBySource(d)).toEqual({
      CHATGPT: '2026-07-05T00:00:00.000Z',
      CLAUDE: null,
      GEMINI: '2026-07-03T00:00:00.000Z'
    })
    d.close()
  })
})
