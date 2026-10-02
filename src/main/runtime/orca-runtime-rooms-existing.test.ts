import {
  hostTestStub,
  hostTestHistoryPage
} from '../native-chat/agent-session-wire/structured-agent-session-host-test-harness'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { setStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import { OrcaRuntimeService } from './orca-runtime'
import { aiVaultSessionFixture } from '../../shared/ai-vault-session.test-fixture'

afterEach(() => setStructuredAgentSessionHost(null))

describe('room existing structured sessions', () => {
  it('lists an attached structured session once and suppresses its provider history duplicate', async () => {
    const runtime = new OrcaRuntimeService()
    vi.spyOn(runtime, 'ensureStructuredAgentSessionHost').mockResolvedValue(undefined)
    vi.spyOn(runtime, 'listRoomRunningAgents').mockResolvedValue([])
    runtime['listRoomHistoricalSessions'] = vi.fn(async () => [
      aiVaultSessionFixture({
        id: 'history-owned',
        sessionId: 'provider-1',
        title: 'duplicate',
        model: null,
        modifiedAt: '',
        filePath: '/tmp/provider-1.jsonl'
      }),
      aiVaultSessionFixture({
        id: 'history-free',
        sessionId: 'provider-2',
        title: 'free',
        model: null,
        modifiedAt: '',
        filePath: '/tmp/provider-2.jsonl'
      })
    ])
    setStructuredAgentSessionHost(
      hostTestStub({
        listSessionTabs: () => [
          { sessionId: 'room_session_1', workspaceId: 'worktree-1', agent: 'codex' }
        ],
        history: async () => ({
          ok: true,
          providerSession: { key: 'session_id', id: 'provider-1' },
          page: hostTestHistoryPage([
            {
              itemId: 'user-1',
              revision: 1,
              sequence: 1,
              observedAt: 1_800_000_000_000,
              body: {
                kind: 'message',
                role: 'user',
                blocks: [{ type: 'text', text: 'existing structured session' }]
              }
            }
          ])
        })
      })
    )

    const candidates = await runtime.listRoomExistingAgents('worktree-1', 'codex', true)

    expect(candidates.map((candidate) => candidate.id)).toEqual([
      'conversation:room_session_1',
      'history-free'
    ])
    expect(candidates[0]).toMatchObject({
      conversationId: 'room_session_1',
      providerSession: {
        id: 'room_session_1',
        transport: 'machine',
        sourceSessionId: 'provider-1'
      }
    })
  })
})
