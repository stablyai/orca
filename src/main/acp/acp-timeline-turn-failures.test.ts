import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalRenderItem } from '../../shared/agent-session-journal-types'
import {
  closeProviderTimelineRigs,
  messageText,
  providerTurnItemId
} from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { openAcpFixtureRig } from './acp-timeline-fixture.test-support'
import { AcpAgentError } from './acp-errors'

afterEach(closeProviderTimelineRigs)
afterEach(() => vi.restoreAllMocks())

// The shape Grok sends for a prompt its API refused, with the reason scrubbed to a placeholder.
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
// Grok's API record for a usage limit, with a constructed tail.
const LIMIT_REASON =
  'API error (status 429 Too Many Requests): rate_limit_exceeded: You have reached your usage limit.'
const details = (text: string) => ({
  provider: 'grok',
  kind: 'turn:failed',
  payload: expect.objectContaining({ head: text, truncated: false })
})
// The reason is an API record, so the row names Grok and keeps the reason on its fact and Details.
const FAILED_ROW = {
  kind: 'status',
  tone: 'error',
  text: 'Grok ran into a problem. Check the chat before trying again.',
  failure: { kind: 'providerError', detail: { text: REASON, audience: 'person' } },
  providerFrame: details(REASON)
}
const LIMIT_ROW = {
  kind: 'status',
  tone: 'error',
  text: 'Grok usage limit reached.',
  providerFrame: details(LIMIT_REASON)
}

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
    expect(statusRows(await f.rig.rows())[0]?.body).toEqual(FAILED_ROW)
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
    // The turn ran, so the row reads as Codex's turn-ending error does: no refusal sentence.
    expect(failures[0]?.body).toEqual(FAILED_ROW)
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
    expect(failures[0]?.body).toEqual(FAILED_ROW)
  })

  it.each(['retry_state', 'turn_completed', 'prompt_complete', 'prompt error answer'] as const)(
    'reads the reason when only the %s carries it',
    async (source) => {
      const f = await openAcpFixtureRig()
      const lane = f.lane()
      const prompt = lane.openPrompt('c1', 1000)
      const reason = (carrier: typeof source) => (carrier === source ? REASON : undefined)
      f.apply(lane.notification('_x.ai/queue/changed', queued(prompt.promptId), 1001))
      if (source === 'retry_state') {
        f.apply(lane.notification('_x.ai/session_notification', retryFailed, 1002))
      }
      f.apply(
        lane.notification(
          '_x.ai/session_notification',
          ended(prompt.promptId, 'error', reason('turn_completed')),
          1003
        )
      )
      f.apply(
        lane.notification(
          '_x.ai/session/prompt_complete',
          promptComplete(prompt.promptId, 'error', reason('prompt_complete') ?? null),
          1004
        )
      )
      f.apply(
        lane.promptFailed(
          'c1',
          source === 'prompt error answer' ? rpcError : new AcpAgentError(-32603, ''),
          1005
        )
      )
      const failures = statusRows(await f.rig.rows())
      expect(failures.map((failure) => failure.body)).toEqual([FAILED_ROW])
    }
  )

  it('keeps the reason when a later copy carries none', async () => {
    const f = await openAcpFixtureRig()
    const lane = f.lane()
    const prompt = lane.openPrompt('c1', 1000)
    f.apply(lane.notification('_x.ai/queue/changed', queued(prompt.promptId), 1001))
    f.apply(lane.notification('_x.ai/session_notification', retryFailed, 1002))
    f.apply(lane.notification('_x.ai/session_notification', ended(prompt.promptId, 'error'), 1003))
    f.apply(lane.promptFailed('c1', new AcpAgentError(-32603, 'Internal error'), 1004))
    const failures = statusRows(await f.rig.rows())
    expect(failures.map((failure) => failure.body)).toEqual([FAILED_ROW])
  })

  it('names a rate-limited turn the provider gave no words for, without inventing a reason', async () => {
    const f = await openAcpFixtureRig()
    const lane = f.lane()
    const prompt = lane.openPrompt('c1', 1000)
    f.apply(lane.notification('_x.ai/queue/changed', queued(prompt.promptId), 1001))
    f.apply(
      lane.notification('_x.ai/session_notification', ended(prompt.promptId, 'rate_limit'), 1002)
    )
    f.apply(
      lane.notification(
        '_x.ai/session/prompt_complete',
        promptComplete(prompt.promptId, 'rate_limit', null),
        1003
      )
    )
    const failures = statusRows(await f.rig.rows())
    expect(failures.map((failure) => failure.body)).toEqual([
      { kind: 'status', tone: 'error', text: 'Grok usage limit reached.' }
    ])
    expect((await f.rig.turns())[0]?.outcome).toBe('failure')
  })

  it('quotes a reason a person can read, and keeps it in Details', async () => {
    const f = await openAcpFixtureRig()
    const lane = f.lane()
    const prompt = lane.openPrompt('c1', 1000)
    const readable = 'The prompt is too long for this model.'
    f.apply(lane.notification('_x.ai/queue/changed', queued(prompt.promptId), 1001))
    f.apply(
      lane.notification(
        '_x.ai/session_notification',
        ended(prompt.promptId, 'error', readable),
        1002
      )
    )
    expect(statusRows(await f.rig.rows()).map((failure) => failure.body)).toEqual([
      {
        kind: 'status',
        tone: 'error',
        text: `Grok ran into a problem: ${readable} Check the chat before trying again.`,
        failure: { kind: 'providerError', detail: { text: readable, audience: 'person' } },
        providerFrame: details(readable)
      }
    ])
  })

  it('logs each reason once, however many copies Grok sends', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const f = await openAcpFixtureRig()
    const lane = f.lane()
    const prompt = lane.openPrompt('c1', 1000)
    f.apply(lane.notification('_x.ai/queue/changed', queued(prompt.promptId), 1001))
    f.apply(lane.notification('_x.ai/session_notification', retryFailed, 1002))
    f.apply(
      lane.notification('_x.ai/session_notification', ended(prompt.promptId, 'error', REASON), 1003)
    )
    f.apply(lane.promptFailed('c1', rpcError, 1004))
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]).toContain(REASON)
  })

  it('leads with the usage limit when Grok words it as an API record', async () => {
    const f = await openAcpFixtureRig()
    const lane = f.lane()
    const prompt = lane.openPrompt('c1', 1000)
    f.apply(lane.notification('_x.ai/queue/changed', queued(prompt.promptId), 1001))
    f.apply(
      lane.notification(
        '_x.ai/session_notification',
        ended(prompt.promptId, 'rate_limit', LIMIT_REASON),
        1002
      )
    )
    f.apply(
      lane.notification(
        '_x.ai/session/prompt_complete',
        promptComplete(prompt.promptId, 'rate_limit', LIMIT_REASON),
        1003
      )
    )
    expect(statusRows(await f.rig.rows()).map((failure) => failure.body)).toEqual([LIMIT_ROW])
  })

  it('keeps the usage limit lead when a later copy of the reason arrives as an error', async () => {
    const f = await openAcpFixtureRig()
    const lane = f.lane()
    const prompt = lane.openPrompt('c1', 1000)
    f.apply(lane.notification('_x.ai/queue/changed', queued(prompt.promptId), 1001))
    f.apply(
      lane.notification('_x.ai/session_notification', ended(prompt.promptId, 'rate_limit'), 1002)
    )
    f.apply(
      lane.promptFailed(
        'c1',
        new AcpAgentError(-32603, 'Internal error', { message: LIMIT_REASON }),
        1003
      )
    )
    expect(statusRows(await f.rig.rows()).map((failure) => failure.body)).toEqual([LIMIT_ROW])
  })

  it('turns an earlier error row into the usage limit when the end says so', async () => {
    const f = await openAcpFixtureRig()
    const lane = f.lane()
    const prompt = lane.openPrompt('c1', 1000)
    f.apply(lane.notification('_x.ai/queue/changed', queued(prompt.promptId), 1001))
    f.apply(
      lane.notification(
        '_x.ai/session_notification',
        grokUpdate({
          sessionUpdate: 'retry_state',
          type: 'failed',
          error_type: 'api',
          message: LIMIT_REASON
        }),
        1002
      )
    )
    f.apply(
      lane.notification(
        '_x.ai/session_notification',
        ended(prompt.promptId, 'rate_limit', LIMIT_REASON),
        1003
      )
    )
    expect(statusRows(await f.rig.rows()).map((failure) => failure.body)).toEqual([LIMIT_ROW])
  })

  it('writes no failure row for a turn the provider ended on purpose', async () => {
    const f = await openAcpFixtureRig()
    const lane = f.lane()
    const prompt = lane.openPrompt('c1', 1000)
    f.apply(lane.notification('_x.ai/queue/changed', queued(prompt.promptId), 1001))
    f.apply(
      lane.notification('_x.ai/session_notification', ended(prompt.promptId, 'max_tokens'), 1002)
    )
    f.apply(lane.promptResult('c1', { stopReason: 'max_tokens' }, 1003))
    expect(statusRows(await f.rig.rows())).toEqual([])
  })

  it('does not reopen or retarget an ended prompt for its late frame', async () => {
    const f = await openAcpFixtureRig()
    const lane = f.lane()
    const prompt = lane.openPrompt('c1', 1000)
    f.apply(lane.notification('_x.ai/queue/changed', queued(prompt.promptId), 1001))
    f.apply(
      lane.notification('_x.ai/session_notification', ended(prompt.promptId, 'end_turn'), 1002)
    )
    f.apply(lane.promptResult('c1', { stopReason: 'end_turn' }, 1003))
    const late = lane.notification(
      'session/update',
      {
        ...session,
        _meta: { promptId: prompt.promptId },
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'late' } }
      },
      1004
    )
    expect(late.filter((event) => event.type === 'turn.open')).toEqual([])
    const promptless = lane.notification(
      'session/update',
      {
        ...session,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'x' } }
      },
      1005
    )
    expect(promptless.find((event) => event.type === 'text.delta')).toMatchObject({
      join: { thread: 'session-1' }
    })
    expect(promptless.find((event) => event.type === 'text.delta')?.join).not.toHaveProperty('turn')
  })
})
