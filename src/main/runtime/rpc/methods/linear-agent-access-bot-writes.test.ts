import '../dispatch/testing/unused-default-rpc-methods.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { LINEAR_AGENT_ACCESS_METHODS } from './integrations/linear/linear-agent-access'
import { readBotWriteTurn } from './bot-write-turn'

vi.mock('./bot-write-turn', () => ({ readBotWriteTurn: vi.fn(async () => null) }))

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

describe('orca linear comment add from a bot', () => {
  it("refuses a bot's waking issue and tags a teammate's comment, from Orca's record of the turn", async () => {
    vi.mocked(readBotWriteTurn).mockResolvedValue({
      bot: { name: 'Scout' },
      inConversation: true,
      turn: {
        rootItemId: 'm1',
        askers: [
          {
            kind: 'person',
            source: 'linear',
            userId: 'u1',
            name: 'Carol',
            workspaceId: 'o1',
            role: 'member'
          }
        ],
        askedBy: [],
        request: null,
        actingOnRequestId: null,
        requestIds: [],
        wokenAt: { source: 'linear', placeId: 'ENG-42' }
      }
    })
    const target = (identifier: string) => ({ issue: { identifier }, workspaceId: 'w1' })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the comment method reads only these runtime members.
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      resolveLinearAgentWriteTarget: vi
        .fn()
        .mockResolvedValueOnce(target('ENG-7'))
        .mockResolvedValueOnce(target('ENG-42')),
      linearIssueAddComment: vi.fn().mockResolvedValue({ ok: true })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: LINEAR_AGENT_ACCESS_METHODS })
    const comment = (input: string) =>
      dispatcher.dispatch(
        makeRequest('linear.issueAddComment', { input, body: 'Done', callerSessionId: 's1' })
      )

    await comment('ENG-7')
    expect(readBotWriteTurn).toHaveBeenCalledWith(runtime, 's1', undefined)
    expect(runtime.linearIssueAddComment).toHaveBeenCalledWith(
      { input: 'ENG-7', body: 'Done\n\nasked by Carol via Scout' },
      undefined
    )

    vi.mocked(runtime.linearIssueAddComment).mockClear()
    const refused = await comment('ENG-42')
    expect(refused).toMatchObject({ ok: false, error: { code: 'linear_waking_issue' } })
    expect(runtime.linearIssueAddComment).not.toHaveBeenCalled()
  })
})
