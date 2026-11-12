import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { agentJournalItemKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { AgentJournalItemBody } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalItemIdentity } from '../../../../shared/agent-session/journal/agent-session-journal-identity'
import type { AgentJournalTurnScope } from '../../../../shared/agent-session/journal/agent-session-journal-turn-scope'
import { readAgentJournalTurn } from '../../../../shared/agent-session/lifecycle/agent-session-turn-record'
import type { StructuredAgentSessionEventSink } from '../../../native-chat/agent-session-wire/journal-ingress/structured-agent-session-event-sink'
import type { StructuredAgentSessionRevisionJournal } from '../../../native-chat/agent-session-wire/journal-ingress/structured-agent-session-journal-views'
import {
  CAPTURED_COMPACT_SESSION_ID,
  type CapturedCompactEvent
} from '../../fixtures/claude-captured-compact-frames.test-fixture'
import { createClaudeJournalTranslator } from '../journal/claude-structured-journal-translation'

const COMMAND_IDENTITY: AgentJournalItemIdentity = {
  provider: 'orca',
  clientMessageId: 'command-turn:cmd-1'
}
const COMMAND_KEY = agentJournalItemKey(COMMAND_IDENTITY)
const NOW = 1_800_000_000_000

const RUNNING = {
  kind: 'turn' as const,
  turnId: 'compact:cmd-1',
  state: 'running' as const,
  userItemId: 'orca:submission:cmd-1',
  requestedAt: 900,
  startedAt: 1_000
}

// Usage limits expire by the system clock; pin it so the quota reset stays an hour ahead.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})
afterEach(() => {
  vi.useRealTimers()
})

type Row = { key: string; body: AgentJournalItemBody; turnScope?: AgentJournalTurnScope }

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
