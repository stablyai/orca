import { afterEach, describe, expect, it, vi } from 'vitest'
import { setStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import { OrcaRuntimeService } from './orca-runtime'

afterEach(() => setStructuredAgentSessionHost(null))

describe('room existing structured sessions', () => {
  it('lists an attached structured session once and suppresses its provider history duplicate', async () => {
    const runtime = new OrcaRuntimeService({} as never)
    vi.spyOn(runtime, 'ensureStructuredAgentSessionHost').mockResolvedValue(undefined)
    vi.spyOn(runtime, 'listRoomRunningAgents').mockResolvedValue([])
    const internal = runtime as unknown as {
      listRoomHistoricalSessions: () => Promise<unknown[]>
    }
    internal.listRoomHistoricalSessions = vi.fn(async () => [
      {
        id: 'history-owned',
        sessionId: 'provider-1',
        title: 'duplicate',
        model: null,
        updatedAt: null,
        modifiedAt: null,
        filePath: '/tmp/provider-1.jsonl'
      },
      {
        id: 'history-free',
        sessionId: 'provider-2',
        title: 'free',
        model: null,
        updatedAt: null,
        modifiedAt: null,
        filePath: '/tmp/provider-2.jsonl'
      }
    ])
    setStructuredAgentSessionHost({
      listSessionTabs: () => [
        { sessionId: 'room_session_1', workspaceId: 'worktree-1', agent: 'codex' }
      ],
      history: () => ({
        ok: true,
        providerSession: { key: 'session_id', id: 'provider-1' },
        page: {
          items: [
            {
              observedAt: 1_800_000_000_000,
              body: {
                kind: 'message',
                role: 'user',
                blocks: [{ type: 'text', text: 'existing structured session' }]
              }
            }
          ]
        }
      })
    } as never)

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
