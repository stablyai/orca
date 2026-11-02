import { readFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import { agentJournalItemKey } from '../../shared/agent-session/journal/agent-session-journal-item-key'
import type { AgentJournalItemBody } from '../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalItemIdentity } from '../../shared/agent-session-journal-identity'
import type { AgentJournalTurnScope } from '../../shared/agent-session-journal-turn-scope'
import { readAgentJournalTurn } from '../../shared/agent-session/lifecycle/agent-session-turn-record'
import type {
  StructuredAgentSessionEventSink,
  StructuredAgentSessionRevisionJournal
} from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import {
  CAPTURED_COMPACT_SESSION_ID,
  CAPTURED_COMPACT_STOPPED_THEN_SEND,
  CAPTURED_COMPACT_SUCCEEDS,
  type CapturedCompactEvent
} from './claude-captured-compact-frames.test-fixture'
import { createClaudeJournalTranslator } from './structured/journal/claude-structured-journal-translation'

const COMMAND_IDENTITY: AgentJournalItemIdentity = {
  provider: 'orca',
  clientMessageId: 'command-turn:cmd-1'
}
const COMMAND_KEY = agentJournalItemKey(COMMAND_IDENTITY)
const QUOTA_RESET_S = Math.floor(Date.now() / 1000) + 3600
const CREDITS = 'This model requires usage credits'
const IN_COMMAND: AgentJournalTurnScope = { kind: 'turn', turnItemId: COMMAND_KEY }
const RUNNING = {
  kind: 'turn' as const,
  turnId: 'compact:cmd-1',
  state: 'running' as const,
  userItemId: 'orca:submission:cmd-1',
  requestedAt: 900,
  startedAt: 1_000
}

type Row = { key: string; body: AgentJournalItemBody; turnScope?: AgentJournalTurnScope }

const rejected = (rateLimitType: string, status = 'rejected') => ({
  type: 'rate_limit_event',
  rate_limit_info: { status, rateLimitType, resetsAt: QUOTA_RESET_S }
})
const COMPACT_QUOTA = "You've hit your limit"
// Typed quota with embedded limit facts, from the provider contract; not a new live capture.
const QUOTA_ASSISTANT = {
  type: 'assistant',
  parent_tool_use_id: null,
  api_error: 'usage_limit_reached',
  error: 'rate_limit',
  is_api_error_message: true,
  api_error_params: {
    rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: QUOTA_RESET_S }
  },
  user_message_uuid: 'compact-input',
  message: { role: 'assistant', content: [{ type: 'text', text: COMPACT_QUOTA }] }
}

/** The recorded signed-out assistant error and result, answering this command's input. */
async function recordedSignedOut(): Promise<Record<string, unknown>[]> {
  const capture = await readFile(
    new URL('./__fixtures__/claude-lifecycle-capture-auth-failed.jsonl', import.meta.url),
    'utf8'
  )
  return capture
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { kind: string; frame?: Record<string, unknown> })
    .flatMap(({ frame }) =>
      frame?.error === 'authentication_failed' || (frame?.type === 'result' && frame.is_error)
        ? [
            {
              ...frame,
              session_id: CAPTURED_COMPACT_SESSION_ID,
              user_message_uuid: 'compact-input',
              user_message_uuids: ['compact-input']
            }
          ]
        : []
    )
}

function harness() {
  const rows = new Map<string, Row>([[COMMAND_KEY, { key: COMMAND_KEY, body: RUNNING }]])
  const writes: Row[] = []
  const write = (
    identity: AgentJournalItemIdentity,
    body: AgentJournalItemBody,
    turnScope?: AgentJournalTurnScope
  ) => {
    const row = { key: agentJournalItemKey(identity), body, ...(turnScope ? { turnScope } : {}) }
    rows.set(row.key, row)
    writes.push(row)
  }
  const journal: StructuredAgentSessionRevisionJournal = {
    item: () => null,
    epoch: 'epoch-1',
    itemBody: (itemId) => rows.get(itemId)?.body ?? null,
    visitItems: (visit) => {
      let sequence = 0
      for (const row of rows.values()) {
        visit(row.key, sequence++, row.body)
      }
    }
  }
  const revise: NonNullable<StructuredAgentSessionEventSink['tryReviseResolvedItem']> = (
    _bytes,
    resolve,
    options
  ) => {
    const resolved = resolve(journal)
    if (resolved) {
      write(resolved.identity, resolved.body, options.turnScope)
    }
    return { accepted: true }
  }
  const sink: StructuredAgentSessionEventSink = {
    appendItem: (identity, body, options) => write(identity, body, options.turnScope),
    appendTombstone: vi.fn(),
    publish: vi.fn(),
    tryReviseResolvedItem: revise,
    tryReviseResolvedItemAndPublish: revise
  }
  const translator = createClaudeJournalTranslator({ sink, fallbackIdPrefix: 'test' })
  const frame = (message: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    translator.handle({
      type: 'message',
      sessionId: 'orca-session',
      message: { session_id: CAPTURED_COMPACT_SESSION_ID, ...message },
      observedAt: 5_000,
      ...extra
    })
  const begin = (sentUuid: string) =>
    translator.beginCommand({
      clientMessageId: 'cmd-1',
      turnId: RUNNING.turnId,
      identity: COMMAND_IDENTITY,
      resultIdentity: { provider: 'orca', clientMessageId: 'command-result:cmd-1' },
      running: RUNNING,
      providerSessionId: CAPTURED_COMPACT_SESSION_ID,
      sentUuid
    })
  const replay = (events: readonly CapturedCompactEvent[]) => {
    for (const event of events) {
      if ('sent' in event) {
        if (event.sent.text === '/compact') {
          begin(event.sent.uuid)
        }
      } else if ('interrupt' in event) {
        translator.commandInterruptRequested(RUNNING.turnId)
      } else {
        frame(event.frame)
      }
    }
  }
  const commandTurn = () => readAgentJournalTurn(rows.get(COMMAND_KEY)?.body)
  const drawn = () =>
    [...rows.values()].filter((row) => row.key !== COMMAND_KEY && row.body.kind !== 'turn')
  return { translator, rows, writes, frame, begin, replay, commandTurn, drawn }
}

describe('a captured /compact as the open Claude turn', () => {
  it.each([
    ['success', 'account event'],
    ['error_during_execution', 'account event'],
    ['success', 'assistant error'],
    ['error_during_execution', 'assistant error']
  ])(
    'retains quota on a failed command with a %s envelope from its %s, before composing its result',
    (subtype, source) => {
      const h = harness()
      h.begin('compact-input')
      // Structured quota/compact sequence from the provider contract; not a new live capture.
      h.frame(source === 'account event' ? rejected('five_hour') : QUOTA_ASSISTANT)
      h.frame({ type: 'system', subtype: 'status', compact_result: 'failed' })
      h.frame({
        type: 'result',
        subtype,
        is_error: subtype !== 'success',
        local_command: 'compact',
        terminal_reason: null,
        result: subtype === 'success' ? '' : COMPACT_QUOTA,
        num_turns: 0,
        user_message_uuid: 'compact-input'
      })
      expect(h.commandTurn()).toMatchObject({ state: 'completed', outcome: 'failure' })
      expect(h.drawn()).toEqual([
        expect.objectContaining({
          key: agentJournalItemKey({
            provider: 'orca',
            clientMessageId: `terminal-failure:claude:${COMMAND_KEY}`
          }),
          turnScope: IN_COMMAND,
          body: expect.objectContaining({
            kind: 'status',
            tone: 'warning',
            failure: expect.objectContaining({
              kind: 'usageLimitReached',
              usageLimit: { window: 'session', resetsAt: QUOTA_RESET_S * 1000 }
            })
          })
        })
      ])
    }
  )

  it.each(['signed out', 'model credits'])(
    'keeps an explicit %s cause over a rejection received during the command',
    async (cause) => {
      const h = harness()
      h.begin('compact-input')
      h.frame(rejected('five_hour'))
      const shown = cause === 'signed out' ? 'Not logged in · Please run /login' : CREDITS
      if (cause === 'signed out') {
        for (const frame of await recordedSignedOut()) {
          h.frame(frame)
        }
      } else {
        // Typed credit refusal, the shape the ordinary usage tests use; not a live capture.
        h.frame({
          type: 'assistant',
          parent_tool_use_id: null,
          api_error: 'model_requires_usage_credits',
          error: 'rate_limit',
          is_api_error_message: true,
          user_message_uuid: 'compact-input',
          message: { role: 'assistant', content: [{ type: 'text', text: CREDITS }] }
        })
        h.frame({
          type: 'system',
          subtype: 'status',
          compact_result: 'failed',
          compact_error: CREDITS
        })
        h.frame({
          type: 'result',
          subtype: 'error_during_execution',
          is_error: true,
          result: CREDITS,
          terminal_reason: 'api_error',
          api_error_status: 429,
          user_message_uuid: 'compact-input'
        })
      }
      expect(h.commandTurn()).toMatchObject({ state: 'completed', outcome: 'failure' })
      const statuses = h.drawn().filter((row) => row.body.kind === 'status')
      expect(statuses).toEqual([
        expect.objectContaining({
          turnScope: IN_COMMAND,
          body: expect.objectContaining({ text: expect.stringContaining(shown) })
        })
      ])
      expect(
        statuses.some(
          (row) => row.body.kind === 'status' && row.body.failure?.kind === 'usageLimitReached'
        )
      ).toBe(false)
    }
  )

  it.each(['received before the command', 'cleared during it'])(
    "keeps Claude's own refusal command-owned when the only rejection was %s",
    (when) => {
      const h = harness()
      if (when === 'received before the command') {
        h.frame(rejected('five_hour'))
        h.begin('compact-input')
      } else {
        // A blanket "rejected during this command" flag would borrow the older weekly limit.
        h.frame(rejected('seven_day'))
        h.begin('compact-input')
        h.frame(rejected('five_hour'))
        h.frame(rejected('five_hour', 'allowed'))
      }
      h.frame({
        type: 'system',
        subtype: 'status',
        compact_result: 'failed',
        compact_error: 'Not enough messages to compact.'
      })
      h.frame({
        type: 'result',
        subtype: 'success',
        is_error: false,
        user_message_uuid: 'compact-input'
      })
      expect(h.commandTurn()).toMatchObject({ state: 'completed', outcome: 'failure' })
      expect(h.drawn().map((row) => row.body)).toEqual([
        expect.objectContaining({
          text: 'Compaction failed: Not enough messages to compact.',
          failure: expect.objectContaining({ kind: 'compactionFailed' })
        })
      ])
    }
  )

  it.each(['success', 'stop', 'unconfirmed', 'allowed', 'expired', 'other-error'])(
    'does not turn %s into quota failure from an account observation',
    (control) => {
      const h = harness()
      h.begin('compact-input')
      h.frame({
        type: 'rate_limit_event',
        rate_limit_info: {
          status: 'rejected',
          rateLimitType: 'five_hour',
          resetsAt: control === 'expired' ? 1 : QUOTA_RESET_S
        }
      })
      if (control === 'success') {
        h.frame({ type: 'system', subtype: 'compact_boundary' })
      } else if (control !== 'unconfirmed') {
        h.frame({ type: 'system', subtype: 'status', compact_result: 'failed' })
      }
      if (control === 'stop') {
        h.translator.commandInterruptRequested(RUNNING.turnId)
      }
      if (control === 'allowed') {
        h.frame({
          type: 'rate_limit_event',
          rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour' }
        })
      }
      h.frame({
        type: 'result',
        subtype: control === 'other-error' ? 'error_during_execution' : 'success',
        is_error: control === 'other-error',
        user_message_uuid: 'compact-input',
        ...(control === 'other-error'
          ? { api_error_status: 403, terminal_reason: 'api_error' }
          : {})
      })
      expect(
        h
          .drawn()
          .some(
            (row) => row.body.kind === 'status' && row.body.failure?.kind === 'usageLimitReached'
          )
      ).toBe(false)
      expect(h.commandTurn()?.outcome).toBe(
        control === 'success' ? 'success' : control === 'stop' ? 'cancellation' : 'failure'
      )
    }
  )

  it('ends a finished compaction as a success, drawing only the compaction separator', () => {
    const { replay, commandTurn, drawn, translator } = harness()
    replay(CAPTURED_COMPACT_SUCCEEDS)

    expect(commandTurn()).toMatchObject({
      turnId: RUNNING.turnId,
      state: 'completed',
      outcome: 'success',
      userItemId: RUNNING.userItemId,
      requestedAt: RUNNING.requestedAt,
      startedAt: RUNNING.startedAt
    })
    expect(drawn()).toEqual([
      {
        key: agentJournalItemKey({ provider: 'orca', clientMessageId: 'command-result:cmd-1' }),
        body: { kind: 'status', text: 'Context compacted', presentation: 'compaction' },
        turnScope: IN_COMMAND
      }
    ])
    expect(translator.commandTurnId).toBeNull()
  })

  it("ends a stopped compaction as the user's cancellation, then answers the next send in its own turn", () => {
    const { replay, commandTurn, drawn, rows } = harness()
    replay(CAPTURED_COMPACT_STOPPED_THEN_SEND)

    expect(commandTurn()).toMatchObject({ state: 'interrupted', outcome: 'cancellation' })
    const answer = drawn().find((row) => row.body.kind === 'message')
    expect(answer?.body).toMatchObject({ role: 'assistant' })
    expect(answer?.turnScope).not.toEqual(IN_COMMAND)
    const answered = readAgentJournalTurn(
      answer?.turnScope?.kind === 'turn' ? rows.get(answer.turnScope.turnItemId)?.body : undefined
    )
    expect(answered).toMatchObject({ state: 'completed', outcome: 'success' })
    expect(drawn().filter((row) => row.body.kind === 'status')).toEqual([])
  })

  it('reads a compaction with no boundary and no stop as a failure, with Claude’s reason', () => {
    const { replay, commandTurn, drawn } = harness()
    replay(CAPTURED_COMPACT_STOPPED_THEN_SEND.filter((event) => !('interrupt' in event)))

    expect(commandTurn()).toMatchObject({ state: 'completed', outcome: 'failure' })
    expect(
      drawn().filter(
        (row) => row.turnScope?.kind === 'turn' && row.turnScope.turnItemId === COMMAND_KEY
      )
    ).toEqual([
      expect.objectContaining({
        body: {
          kind: 'status',
          text: 'Compaction failed: API Error: Request was aborted.',
          failure: {
            kind: 'compactionFailed',
            detail: { text: 'API Error: Request was aborted.', audience: 'person' }
          },
          tone: 'error'
        }
      })
    ])
  })

  it('reads a stop that lands after the summary but before the boundary as a cancellation', () => {
    const { replay, commandTurn, drawn } = harness()
    replay(
      CAPTURED_COMPACT_SUCCEEDS.flatMap((event): CapturedCompactEvent[] =>
        'frame' in event && event.frame.subtype === 'compact_boundary'
          ? []
          : 'frame' in event && event.frame.compact_result === 'success'
            ? [event, { at: event.at, interrupt: true }]
            : [event]
      )
    )

    expect(commandTurn()).toMatchObject({ state: 'interrupted', outcome: 'cancellation' })
    expect(drawn().filter((row) => row.body.kind === 'status')).toEqual([])
  })

  it('leaves the command running at a result that names another input', () => {
    const { begin, frame, commandTurn, translator } = harness()
    begin('compact-input')
    frame({ type: 'system', subtype: 'compact_boundary', uuid: 'boundary' })
    frame({ type: 'result', subtype: 'success', is_error: false, user_message_uuid: 'earlier' })
    expect(commandTurn()?.state).toBe('running')
    expect(translator.commandTurnId).toBe(RUNNING.turnId)

    frame({
      type: 'result',
      subtype: 'success',
      is_error: false,
      user_message_uuid: 'compact-input'
    })
    expect(commandTurn()).toMatchObject({ state: 'completed', outcome: 'success' })
  })
})

describe('the command turn at each point the ordinary result path threads through', () => {
  it('suppresses a provider reopen after a command that failed, as after any failed turn', () => {
    const failed = harness()
    failed.begin('compact-input')
    failed.frame({ type: 'result', subtype: 'error_during_execution', is_error: true })
    failed.frame({
      type: 'assistant',
      uuid: 'stray',
      parent_tool_use_id: null,
      message: { id: 'msg-stray', role: 'assistant', content: [{ type: 'text', text: 'hi' }] }
    })
    expect(failed.translator.currentTurnId).toBeNull()

    const finished = harness()
    finished.begin('compact-input')
    finished.frame({ type: 'system', subtype: 'compact_boundary', uuid: 'boundary' })
    finished.frame({ type: 'result', subtype: 'success', is_error: false })
    finished.frame({
      type: 'assistant',
      uuid: 'resumed',
      parent_tool_use_id: null,
      message: { id: 'msg-resumed', role: 'assistant', content: [{ type: 'text', text: 'hi' }] }
    })
    expect(finished.translator.currentTurnId).not.toBeNull()
  })

  it("records the context window the command's result reports on the command's turn", () => {
    const { begin, frame, commandTurn } = harness()
    begin('compact-input')
    frame({ type: 'system', subtype: 'init', model: 'claude-opus-5-5[1m]', uuid: 'init' })
    frame({ type: 'system', subtype: 'compact_boundary', uuid: 'boundary' })
    frame({
      type: 'result',
      subtype: 'success',
      is_error: false,
      modelUsage: { 'claude-opus-5-5[1m]': { contextWindow: 1_000_000 } }
    })
    expect(commandTurn()).toMatchObject({
      state: 'completed',
      contextUsage: { window: { tokens: 1_000_000 } }
    })
  })

  it("reports a compaction Claude refused in Claude's own words, and one with none plainly", () => {
    const worded = harness()
    worded.begin('compact-input')
    worded.frame({
      type: 'system',
      subtype: 'status',
      compact_result: 'failed',
      compact_error: 'Not enough messages to compact.'
    })
    worded.frame({ type: 'result', subtype: 'success', is_error: false })
    expect(worded.commandTurn()).toMatchObject({ state: 'completed', outcome: 'failure' })
    expect(worded.drawn().map((row) => row.body)).toEqual([
      {
        kind: 'status',
        text: 'Compaction failed: Not enough messages to compact.',
        failure: {
          kind: 'compactionFailed',
          detail: { text: 'Not enough messages to compact.', audience: 'person' }
        },
        tone: 'error'
      }
    ])

    const unworded = harness()
    unworded.begin('compact-input')
    unworded.frame({ type: 'system', subtype: 'status', compact_result: 'failed' })
    unworded.frame({ type: 'result', subtype: 'success', is_error: false })
    expect(unworded.drawn().map((row) => row.body)).toEqual([
      {
        kind: 'status',
        text: 'Compaction failed.',
        failure: { kind: 'compactionFailed' },
        tone: 'error'
      }
    ])
  })

  it('reports a result with no compaction and no failure as a compaction Claude never confirmed', () => {
    const { begin, frame, commandTurn, drawn } = harness()
    begin('compact-input')
    frame({ type: 'result', subtype: 'success', is_error: false })
    expect(commandTurn()).toMatchObject({ state: 'completed', outcome: 'failure' })
    expect(drawn().map((row) => row.body)).toEqual([
      {
        kind: 'status',
        text: 'Compaction completion is unconfirmed.',
        failure: { kind: 'compactionUnconfirmed' },
        tone: 'error'
      }
    ])
  })

  it('fails a command whose result ended in error', () => {
    const { begin, frame, commandTurn } = harness()
    begin('compact-input')
    frame({ type: 'result', subtype: 'error_during_execution', is_error: true })
    expect(commandTurn()).toMatchObject({ state: 'completed', outcome: 'failure' })
  })

  it("draws one error row, the provider's, for a command whose result is an error", () => {
    const { begin, frame, drawn } = harness()
    begin('compact-input')
    frame({
      type: 'result',
      subtype: 'success',
      is_error: true,
      result: 'API Error: 529 upstream overloaded'
    })
    expect(drawn().filter((row) => row.body.kind === 'status')).toEqual([
      expect.objectContaining({
        body: expect.objectContaining({ text: 'API Error: 529 upstream overloaded' }),
        turnScope: IN_COMMAND
      })
    ])
  })
})
