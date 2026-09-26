// A compaction Codex refuses up front keeps Codex's own words for the chat's failure row.

import { describe, expect, it } from 'vitest'
import { CodexAppServerRequestError } from './codex-app-server-connection'
import { acquired, fakeCodex } from './codex-structured-session-adapter-fixture'

describe('Codex compaction refused at the request', () => {
  it("carries Codex's message as the detail, apart from Orca's wrapper", async () => {
    const codex = fakeCodex({
      'thread/compact/start': () => {
        throw new CodexAppServerRequestError(
          'thread/compact/start',
          -32600,
          'codex app-server thread/compact/start failed: thread has nothing to compact',
          'thread has nothing to compact'
        )
      }
    })
    const adapter = await acquired(codex)

    await expect(
      adapter.compact({ turnId: 'compact-1', sessionId: 'session-1', fence: 7 })
    ).resolves.toEqual({
      outcome: 'failed',
      detail: { text: 'thread has nothing to compact', audience: 'person' }
    })
  })
})
