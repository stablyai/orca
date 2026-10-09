// A `/compact` as the Claude translator's open turn, driven by real captured frames: which of them
// end the command, how, and what the timeline draws.

import { describe, expect, it, vi } from 'vitest'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity,
  AgentJournalTurnScope
} from '../../shared/agent-session-journal-types'
import { readAgentJournalTurn } from '../../shared/agent-session-turn-record'
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
import { createClaudeJournalTranslator } from './claude-structured-journal-translation'

const COMMAND_IDENTITY: AgentJournalItemIdentity = {
  provider: 'orca',
  clientMessageId: 'command-turn:cmd-1'
}
const COMMAND_KEY = agentJournalItemKey(COMMAND_IDENTITY)
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

/** A sink over a journal that holds the host's running command turn, revising rows in place. */
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
  /** Replays a capture as the adapter delivers it: `/compact` goes through `beginCommand`, and a
   *  Stop marks the interrupt the way the cancel path does. */
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
    // Not the continuation summary, not the command's echo, not a lifecycle opcode row.
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

    // Claude's result for the stopped command is `success` like a finished one's.
    expect(commandTurn()).toMatchObject({ state: 'interrupted', outcome: 'cancellation' })
    const answer = drawn().find((row) => row.body.kind === 'message')
    expect(answer?.body).toMatchObject({ role: 'assistant' })
    expect(answer?.turnScope).not.toEqual(IN_COMMAND)
    const answered = readAgentJournalTurn(
      answer?.turnScope?.kind === 'turn' ? rows.get(answer.turnScope.turnItemId)?.body : undefined
    )
    expect(answered).toMatchObject({ state: 'completed', outcome: 'success' })
    // "Compaction canceled." is the command's own output, and a stop earns no failure row.
    expect(drawn().filter((row) => row.body.kind === 'status')).toEqual([])
  })

  it('reads a compaction with no boundary and no stop as a failure, with Claude’s reason', () => {
    const { replay, commandTurn, drawn } = harness()
    // The stopped capture without Orca's stop: Claude reported the compaction failed.
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
          text: "Claude couldn't shorten this chat's history.",
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
    // Only the boundary says the conversation was replaced; the status that precedes it does not.
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

  it("settles a child still working in the command's turn when the command ends", () => {
    const { begin, frame, rows } = harness()
    begin('compact-input')
    frame({
      type: 'system',
      subtype: 'task_started',
      task_id: 'task-1',
      task_type: 'local_agent',
      description: 'Map the lane'
    })
    frame({ type: 'result', subtype: 'success', is_error: false })
    const group = rows.get(
      agentJournalItemKey({
        provider: 'orca',
        clientMessageId: `claude-subagents:${CAPTURED_COMPACT_SESSION_ID}:${RUNNING.turnId}`
      })
    )
    const agents =
      group?.body.kind === 'message'
        ? group.body.blocks.flatMap((block) =>
            block.type === 'subagent-group' ? block.agents : []
          )
        : []
    expect(agents).toEqual([expect.objectContaining({ state: 'unverifiable' })])
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
        text: "Claude couldn't shorten this chat's history: Not enough messages to compact.",
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
        text: "Claude couldn't shorten this chat's history.",
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
        text: "Claude hasn't confirmed that this chat's history was shortened. Check the chat before running /compact again.",
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
