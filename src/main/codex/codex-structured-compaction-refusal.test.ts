// A compaction Codex refuses up front keeps Codex's own words for the chat's failure row.

import { describe, expect, it } from 'vitest'
import { structuredAgentSessionCommandTurn } from '../native-chat/agent-session-wire/structured-agent-session-command-turn'
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
    const turn = structuredAgentSessionCommandTurn('cmd-1')

    await expect(
      adapter.compact({
        sessionId: 'session-1',
        fence: 7,
        command: {
          clientMessageId: 'cmd-1',
          ...turn,
          running: { kind: 'turn', turnId: turn.turnId, state: 'running' }
        }
      })
    ).resolves.toEqual({
      state: 'rejected',
      reason: "Codex didn't accept this message: thread has nothing to compact.",
      rejection: {
        kind: 'providerRejected',
        detail: { text: 'thread has nothing to compact', audience: 'person' }
      }
    })
  })
})
