import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { chatImportDbPath } from './chat-import-paths'

describe('chatImportDbPath', () => {
  it('joins chat-import/chats.db under the given userData path', () => {
    expect(chatImportDbPath('/tmp/orca-user-data')).toBe(
      join('/tmp/orca-user-data', 'chat-import', 'chats.db')
    )
  })
})
