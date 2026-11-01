import { describe, expect, it, vi } from 'vitest'
import { latestNativeChatUsageLimitCut } from '../../shared/native-chat/native-chat-usage-limit-cut'
import { agentJournalSubmissionKey } from '../../shared/agent-session-journal-item-key'
import {
  adapterFor,
  fakeClaude,
  identityFor,
  PROVIDER_SESSION_ID,
  USER_MESSAGE
} from './claude-structured-session-test-support'
import { assistantFrame, frame, setup, userFrame } from './claude-context-usage-test-support'

// Seconds, as Claude sends them; two hours out so no reset passes mid-test.
const RESETS_AT_S = Math.floor(Date.now() / 1000) + 2 * 3600

const rateLimitEvent = (status: string, at: number) =>
  frame(
    {
      type: 'rate_limit_event',
      uuid: `rate-${at}`,
      rate_limit_info: { status, rateLimitType: 'five_hour', resetsAt: RESETS_AT_S }
    },
    at
  )

const refusedFrame = (uuid: string, at: number, text: string) =>
  frame(
    {
      type: 'assistant',
      uuid,
      user_message_uuid: `turn-${uuid}`,
      error: 'rate_limit',
      is_api_error_message: true,
      message: { role: 'assistant', content: [{ type: 'text', text }] }
    },
    at
  )

const failedResult = (uuid: string, at: number, text: string) =>
  frame(
    {
      type: 'result',
      subtype: 'success',
      is_error: true,
      result: text,
      uuid: `result-${uuid}`,
      user_message_uuid: `turn-${uuid}`,
      duration_ms: 10
    },
    at
  )

const LIMIT_TEXT = "You've hit your limit · resets 3pm"

function statusRows(t: ReturnType<typeof setup>) {
  return t.items().flatMap((item) => (item.body.kind === 'status' ? [item.body] : []))
}

function messageTexts(t: ReturnType<typeof setup>): string[] {
  return t
    .items()
    .flatMap((item) =>
      item.body.kind === 'message'
        ? item.body.blocks.flatMap((block) => (block.type === 'text' ? [block.text] : []))
        : []
    )
}

describe('a Claude usage limit', () => {
  it.each([false, true])(
    'keeps one limit row across a result and idle (quota first %s)',
    (quotaFirst) => {
      const t = setup()
      if (!quotaFirst) {
        t.handle(userFrame('turn-a', 1_000))
      }
      t.handle(rateLimitEvent('rejected', 1_100))
      if (!quotaFirst) {
        t.handle(
          frame(
            { ...assistantFrame('first', 1_150, 20).message, user_message_uuid: 'turn-a' },
            1_150
          )
        )
      }
      t.handle(
        frame(
          {
            ...refusedFrame('a', 1_200, LIMIT_TEXT).message,
            user_message_uuid: undefined,
            api_error: 'usage_limit_reached'
          },
          1_200
        )
      )
      t.handle(failedResult('a', 1_300, 'Request failed'))
      t.handle(frame({ type: 'system', subtype: 'session_state_changed', state: 'idle' }, 1_301))
      // The CLI throttles an unchanged rejection: the next turn carries none.
      t.handle(userFrame('turn-b', 2_000))
      t.handle(refusedFrame('b', 2_200, LIMIT_TEXT))
      t.handle(failedResult('b', 2_300, LIMIT_TEXT))

      const limitRow = {
        kind: 'status',
        tone: 'warning',
        text: 'Claude hit its session limit.',
        failure: {
          kind: 'usageLimitReached',
          usageLimit: { window: 'session', resetsAt: RESETS_AT_S * 1000 },
          detail: { text: LIMIT_TEXT, audience: 'person' }
        }
      }
      expect(statusRows(t)).toEqual([
        {
          ...limitRow,
          failure: {
            ...limitRow.failure,
            detail: { text: `${LIMIT_TEXT}\nRequest failed`, audience: 'person' }
          }
        },
        limitRow
      ])
      expect(messageTexts(t)).not.toContain(LIMIT_TEXT)
      t.translator.dispose()
    }
  )

  it('keeps a removed-media notice before later work and its usage-limit warning', () => {
    const t = setup({ deferred: true })
    const removed = 'API Error: the image could not be processed and was removed'
    t.handle(userFrame('turn-a', 1000))
    t.handle(
      frame(
        {
          ...refusedFrame('media', 1100, removed).message,
          api_error: 'media_removed',
          error: undefined,
          user_message_uuid: 'turn-a'
        },
        1100
      )
    )
    t.handle(assistantFrame('answer', 1200, 20))
    t.handle(
      frame(
        { ...refusedFrame('a', 1300, LIMIT_TEXT).message, api_error: 'usage_limit_reached' },
        1300
      )
    )
    t.handle(failedResult('a', 1400, LIMIT_TEXT))
    t.flush()
    const visible = t
      .items()
      .flatMap(({ body }) =>
        body.kind === 'message' && body.role === 'assistant'
          ? body.blocks.flatMap((block) => (block.type === 'text' ? [block.text] : []))
          : body.kind === 'status' && body.failure?.kind === 'usageLimitReached'
            ? ['quota']
            : []
      )
    expect(visible).toEqual([removed, 'answer', 'quota'])
    t.translator.dispose()
  })

  it('keeps typed other causes and replacement turns separate from the account snapshot', () => {
    const t = setup()
    t.handle(userFrame('turn-limited', 1_000))
    t.handle(rateLimitEvent('rejected', 1_100))
    t.handle(refusedFrame('limited', 1_200, LIMIT_TEXT))
    // No result: a replacement turn must not inherit the previous refusal.
    t.handle(userFrame('turn-credits', 2_000))
    t.handle(
      frame(
        {
          ...refusedFrame('credits', 2_100, 'This model requires usage credits').message,
          api_error: 'model_requires_usage_credits'
        },
        2_100
      )
    )
    t.handle(
      frame(
        {
          ...failedResult('credits', 2_200, 'This model requires usage credits').message,
          terminal_reason: 'api_error',
          api_error_status: 429
        },
        2_200
      )
    )
    expect(statusRows(t).filter((row) => row.failure?.kind === 'usageLimitReached')).toHaveLength(1)
    expect(statusRows(t).some((row) => row.text.includes('requires usage credits'))).toBe(true)
    t.handle(userFrame('turn-context', 2300))
    t.handle(
      frame(
        {
          ...refusedFrame('context', 2400, 'Prompt is too long').message,
          error: 'invalid_request'
        },
        2400
      )
    )
    t.handle(
      frame(
        {
          ...failedResult('context', 2500, 'Prompt is too long').message,
          terminal_reason: 'blocking_limit',
          api_error_status: null
        },
        2500
      )
    )
    expect(statusRows(t).at(-1)).toMatchObject({ tone: 'error', text: 'Prompt is too long' })
    t.translator.dispose()
  })

  it('keeps an explicit quota cause without metadata and expires snapshot inference', () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(RESETS_AT_S * 1000 - 1000)
    try {
      const t = setup()
      t.handle(userFrame('turn-typed', 1000))
      t.handle(
        frame(
          { ...refusedFrame('typed', 1100, LIMIT_TEXT).message, api_error: 'usage_limit_reached' },
          1100
        )
      )
      t.handle(failedResult('typed', 1200, LIMIT_TEXT))
      t.handle(rateLimitEvent('rejected', 1300))
      clock.mockReturnValue(RESETS_AT_S * 1000 + 1000)
      t.handle(userFrame('turn-expired', 2000))
      t.handle(refusedFrame('expired', 2100, 'Request rejected'))
      t.handle(failedResult('expired', 2200, 'Request rejected'))
      const limits = statusRows(t).filter((row) => row.failure?.kind === 'usageLimitReached')
      expect(limits).toHaveLength(1)
      expect(limits[0]?.failure?.usageLimit).toBeUndefined()
      t.translator.dispose()
    } finally {
      clock.mockRestore()
    }
  })

  it('leaves a throttle once the limit allows requests again', () => {
    const t = setup()
    t.handle(rateLimitEvent('rejected', 1_100))
    t.handle(rateLimitEvent('allowed_warning', 1_500))
    t.handle(userFrame('turn-a', 2_000))
    t.handle(refusedFrame('a', 2_200, 'API Error: Request rejected (429)'))
    t.handle(failedResult('a', 2_300, 'API Error: Request rejected (429)'))

    expect(statusRows(t).map((row) => row.failure?.kind)).not.toContain('usageLimitReached')
    expect(statusRows(t)).toContainEqual(
      expect.objectContaining({ tone: 'error', text: 'API Error: Request rejected (429)' })
    )
    t.translator.dispose()
  })
})

const quota = (uuid: string, stamp?: string) =>
  frame(
    {
      ...refusedFrame(uuid, 1100, LIMIT_TEXT).message,
      user_message_uuid: stamp,
      api_error: 'usage_limit_reached'
    },
    1100
  )

it.each(['idle', 'exit'] as const)(
  'keeps quota failure and Continue through a deferred resultless %s',
  (ending) => {
    const t = setup({ deferred: true })
    t.handle(userFrame('owner', 1000))
    t.handle(quota('refusal', 'owner'))
    if (ending === 'idle') {
      t.handle(frame({ type: 'system', subtype: 'session_state_changed', state: 'idle' }, 1200))
    } else {
      t.handle({
        type: 'ended',
        sessionId: 'orca-session',
        reason: 'Provider exited',
        observedAt: 1200
      })
    }
    t.flush()
    expect(t.turnRow('owner')?.body).toMatchObject({
      state: ending === 'idle' ? 'completed' : 'interrupted',
      outcome: 'failure'
    })
    expect(latestNativeChatUsageLimitCut(t.items(), [])).not.toBeNull()
    t.translator.dispose()
  }
)

it.each(['before', 'after', 'child', 'ordinary', 'success', 'other', 'superseded'] as const)(
  'preserves %s precedence over resultless quota inference',
  (mode) => {
    const t = setup({ deferred: true })
    t.handle(userFrame('owner', 1000))
    if (mode !== 'ordinary') {
      t.handle(
        frame(
          {
            ...quota('refusal', 'owner').message,
            ...(mode === 'child' ? { parent_tool_use_id: 'child-tool' } : {})
          },
          1100
        )
      )
    }
    if (mode === 'other') {
      t.handle(
        frame(
          {
            ...refusedFrame('other', 1150, 'Requires credits').message,
            api_error: 'model_requires_usage_credits',
            user_message_uuid: 'owner'
          },
          1150
        )
      )
    }
    if (mode === 'before') {
      t.queueStop('owner', 1150)
      expect(t.sink.journalStopDecidesTurn?.('owner', 1200)).toBe(false)
    }
    if (mode === 'success') {
      t.handle(frame({ type: 'result', subtype: 'success', is_error: false, result: 'done' }, 1200))
    } else if (mode === 'superseded') {
      t.handle(userFrame('newer', 1200))
    } else if (mode === 'before') {
      t.handle(frame({ type: 'system', subtype: 'session_state_changed', state: 'idle' }, 1200))
    } else {
      t.handle({
        type: 'ended',
        sessionId: 'orca-session',
        reason: 'Provider exited',
        observedAt: 1200
      })
    }
    if (mode === 'after') {
      t.queueStop('owner', 1300)
    }
    t.flush()
    const outcome =
      mode === 'before'
        ? 'cancellation'
        : mode === 'after'
          ? 'failure'
          : mode === 'success'
            ? 'success'
            : mode === 'superseded'
              ? 'superseded'
              : undefined
    const body = t.turnRow('owner')?.body
    expect(body?.kind === 'turn' ? body.outcome : null).toEqual(outcome)
    expect(latestNativeChatUsageLimitCut(t.items(), []) !== null).toBe(mode === 'after')
    t.translator.dispose()
  }
)

it('retains a newly accepted pre-echo failure after acquisition has consumed its exact waiter', async () => {
  const t = setup()
  t.translator.dispose()
  const claude = fakeClaude({ replayUuid: null })
  const adapter = adapterFor(claude)
  await adapter.acquire({
    identity: identityFor(),
    fence: 7,
    spawnToken: 'quota-test',
    events: t.sink
  })
  const connection = claude.connections[0]!
  const emit = (message: Record<string, unknown>) =>
    connection.handlers.onMessage?.({
      parent_tool_use_id: null,
      ...message,
      session_id: PROVIDER_SESSION_ID
    })
  await adapter.dispatch({
    sessionId: 'session-1',
    clientMessageId: 'first',
    body: USER_MESSAGE,
    fence: 7
  })
  emit({ ...connection.sent[0], uuid: 'owner' })
  emit(quota('refusal', 'owner').message)
  emit({ ...failedResult('owner', 1200, LIMIT_TEXT).message, user_message_uuid: 'owner' })
  t.sink.appendItem({ provider: 'orca', clientMessageId: 'new-send' }, USER_MESSAGE, {
    turnScope: { kind: 'thread' }
  })
  await adapter.dispatch({
    sessionId: 'session-1',
    clientMessageId: 'new-send',
    body: USER_MESSAGE,
    fence: 7
  })
  const sent = connection.sent.at(-1)!
  emit({
    type: 'result',
    uuid: 'new-result',
    user_message_uuid: sent.uuid,
    subtype: 'error_during_execution',
    is_error: true,
    result: 'Fresh request rejected'
  })
  expect(t.items().some((item) => item.itemId === agentJournalSubmissionKey('new-send'))).toBe(true)
  expect(statusRows(t).some((row) => row.text.includes('Fresh request rejected'))).toBe(true)
  await adapter.closeSession('session-1')
})
