import { afterEach, describe, expect, it } from 'vitest'
import type { AgentJournalRenderItem } from '../../shared/agent-session/journal/agent-session-journal-types'
import {
  closeProviderTimelineRigs,
  messageText,
  providerTurnItemId
} from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { openAcpFixtureRig } from './acp-timeline-fixture.test-support'
import { AcpAgentError } from './acp-errors'

afterEach(closeProviderTimelineRigs)

// Captured Grok API failure with a placeholder reason.
const REASON = 'API error (status 400 Bad Request): invalid_request_error: placeholder reason'
const session = { sessionId: 'session-1' }
const queued = (promptId: string) => ({ ...session, entries: [], runningPromptId: promptId })
const grokUpdate = (update: Record<string, unknown>) => ({
  ...session,
  update,
  _meta: { agentTimestampMs: 1 }
})
const retryFailed = grokUpdate({
  sessionUpdate: 'retry_state',
  type: 'failed',
  error_type: 'api',
  message: REASON
})
const ended = (promptId: string, stopReason: string, agentResult?: string) =>
  grokUpdate({
    sessionUpdate: 'turn_completed',
    prompt_id: promptId,
    stop_reason: stopReason,
    ...(agentResult === undefined ? {} : { agent_result: agentResult }),
    elapsed_ms: 729
  })
const promptComplete = (promptId: string, stopReason: string, agentResult: string | null) => ({
  ...session,
  promptId,
  stopReason,
  agentResult
})
const rpcError = new AcpAgentError(-32603, 'Internal error', { message: REASON })

function statusRows(rows: AgentJournalRenderItem[]) {
  return rows.flatMap((row) => (row.body.kind === 'status' ? [{ row, body: row.body }] : []))
}

describe('a failed ACP turn says why', () => {
  it('writes the reason once when Grok sends it four times, in the failed turn', async () => {
    const f = await openAcpFixtureRig()
    const lane = f.lane()
    const prompt = lane.openPrompt('c1', 1000)
    f.apply(lane.notification('_x.ai/queue/changed', queued(prompt.promptId), 1001))
    f.apply(lane.notification('_x.ai/session_notification', retryFailed, 1002))
    f.apply(
      lane.notification('_x.ai/session_notification', ended(prompt.promptId, 'error', REASON), 1003)
    )
    expect(statusRows(await f.rig.rows())[0]?.body.text).toBe(REASON)
    f.apply(
      lane.notification(
        '_x.ai/session/prompt_complete',
        promptComplete(prompt.promptId, 'error', REASON),
        1004
      )
    )
    f.apply(lane.promptFailed('c1', rpcError, 1005))
    const next = lane.openPrompt('c2', 1006)
    f.apply(lane.notification('_x.ai/queue/changed', queued(next.promptId), 1007))
    f.apply(
      lane.notification(
        'session/update',
        {
          ...session,
          _meta: { promptId: next.promptId },
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } }
        },
        1008
      )
    )
    f.apply(lane.notification('_x.ai/session_notification', ended(next.promptId, 'end_turn'), 1009))
    f.apply(lane.promptResult('c2', { stopReason: 'end_turn' }, 1010))
    const rows = await f.rig.rows()
    const failures = statusRows(rows)
    expect(failures).toHaveLength(1)
    expect(failures[0]?.body).toEqual({ kind: 'status', tone: 'error', text: REASON })
    const turns = await f.rig.turns()
    expect(turns.map((turn) => [turn.state, turn.outcome])).toEqual([
      ['completed', 'failure'],
      ['completed', 'success']
    ])
    expect(failures[0]?.row.turnScope).toEqual({
      kind: 'turn',
      turnItemId: providerTurnItemId(prompt.promptId)
    })
    expect(
      rows.filter((row) => row.body.kind === 'message').map((row) => messageText(row.body))
    ).toEqual(['ok'])
  })

  it('takes the reason from the prompt error answer when no frame carried it', async () => {
    const f = await openAcpFixtureRig()
    const lane = f.lane()
    const prompt = lane.openPrompt('c1', 1000)
    f.apply(lane.notification('_x.ai/queue/changed', queued(prompt.promptId), 1001))
    f.apply(lane.notification('_x.ai/session_notification', ended(prompt.promptId, 'error'), 1002))
    expect(statusRows(await f.rig.rows())[0]?.body).toEqual({
      kind: 'status',
      tone: 'error',
      text: 'Grok ended this turn with an error.'
    })
    f.apply(lane.promptFailed('c1', rpcError, 1003))
    f.apply(lane.promptFailed('c1', rpcError, 1004))
    const failures = statusRows(await f.rig.rows())
    expect(failures).toHaveLength(1)
    expect(failures[0]?.body).toEqual({ kind: 'status', tone: 'error', text: REASON })
  })

  it('upgrades an early diagnostic to a usage failure without a later downgrade', async () => {
    const f = await openAcpFixtureRig()
    const lane = f.lane()
    const prompt = lane.openPrompt('c1', 1000)
    f.apply(lane.notification('_x.ai/queue/changed', queued(prompt.promptId), 1001))
    f.apply(lane.notification('_x.ai/session_notification', retryFailed, 1002))
    f.apply(
      lane.notification('_x.ai/session_notification', ended(prompt.promptId, 'rate_limit'), 1003)
    )
    f.apply(
      lane.notification(
        '_x.ai/session/prompt_complete',
        promptComplete(prompt.promptId, 'rate_limit', null),
        1003
      )
    )
    f.apply(lane.promptFailed('c1', rpcError, 1004))
    const failures = statusRows(await f.rig.rows())
    expect(failures.map((failure) => failure.body)).toEqual([
      {
        kind: 'status',
        tone: 'warning',
        text: 'The agent hit its usage limit.',
        failure: { kind: 'usageLimitReached', detail: { text: REASON, audience: 'person' } }
      }
    ])
    expect((await f.rig.turns())[0]?.outcome).toBe('failure')
  })

  it.each([null, 'Quota exhausted'])(
    'reads an ordinary prompt_complete rate limit with result %s as one usage failure the RPC settles',
    async (agentResult) => {
      const f = await openAcpFixtureRig()
      const lane = f.lane()
      const prompt = lane.openPrompt('c1', 1000)
      f.apply(lane.notification('_x.ai/queue/changed', queued(prompt.promptId), 1001))
      f.apply(
        lane.notification(
          '_x.ai/session/prompt_complete',
          promptComplete(prompt.promptId, 'rate_limit', agentResult),
          1002
        )
      )
      expect(statusRows(await f.rig.rows()).map(({ body }) => body.tone)).toEqual(['warning'])
      expect((await f.rig.turns())[0]?.state).toBe('running')
      f.apply(lane.promptFailed('c1', new AcpAgentError(-32603, 'Internal error'), 1003))
      expect(statusRows(await f.rig.rows()).map(({ body }) => body)).toEqual([
        {
          kind: 'status',
          tone: 'warning',
          text: 'The agent hit its usage limit.',
          failure: {
            kind: 'usageLimitReached',
            detail: { text: agentResult ?? 'Internal error', audience: 'person' }
          }
        }
      ])
      expect((await f.rig.turns())[0]).toMatchObject({ state: 'completed', outcome: 'failure' })
    }
  )
})
