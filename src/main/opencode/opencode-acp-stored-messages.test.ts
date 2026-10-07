import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  openCodeStoredUserMessagesReader,
  type OpenCodeTranscriptPageReader
} from './opencode-acp-stored-messages'

describe('OpenCode stored user messages', () => {
  it("reads the database under the chat's own home, and only its user messages", async () => {
    const readPage = vi.fn<OpenCodeTranscriptPageReader>(async () => ({
      items: [
        {
          rowid: 1,
          fingerprint: 'a',
          message: { id: 'msg_1', role: 'user', blocks: [], timestamp: 5, source: 'transcript' }
        },
        {
          rowid: 2,
          fingerprint: 'b',
          message: {
            id: 'msg_2',
            role: 'assistant',
            blocks: [],
            timestamp: 6,
            source: 'transcript'
          }
        }
      ],
      hasMore: false,
      beforeMessageRowId: 1
    }))
    const home = join('/', 'child-home')
    const read = openCodeStoredUserMessagesReader(readPage)
    await expect(
      read({
        env: { HOME: home, USERPROFILE: home },
        providerSessionId: 'ses_1',
        signal: new AbortController().signal
      })
    ).resolves.toEqual([{ id: 'msg_1', blocks: [], createdAt: 5 }])
    expect(readPage).toHaveBeenCalledWith(
      expect.objectContaining({
        dbPath: join(home, '.local', 'share', 'opencode', 'opencode.db'),
        sessionId: 'ses_1'
      }),
      expect.anything()
    )
  })
})
