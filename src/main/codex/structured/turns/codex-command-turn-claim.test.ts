import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { agentJournalItemKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { AgentJournalItemBody } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalItemIdentity } from '../../../../shared/agent-session/journal/agent-session-journal-identity'
import type { AgentJournalTurnScope } from '../../../../shared/agent-session/journal/agent-session-journal-turn-scope'
import { readAgentJournalTurn } from '../../../../shared/agent-session/lifecycle/agent-session-turn-record'
import type {
  StructuredAgentSessionEventSink,
  StructuredAgentSessionSinkAdmission
} from '../../../native-chat/agent-session-wire/structured-agent-session-event-sink'
import type { StructuredAgentSessionRevisionJournal } from '../../../native-chat/agent-session-wire/structured-agent-session-journal-views'
import { createCodexJournalTranslator } from '../journal/codex-structured-journal-translation'
import type { CodexStructuredSessionEvent } from '../session-lifecycle/codex-structured-session-state'

const SESSION = 'session-1'
const THREAD = 'thread-1'
const PROVIDER_TURN = 'compact-turn'
const COMMAND_TURN_IDENTITY: AgentJournalItemIdentity = {
  provider: 'orca',
  clientMessageId: 'command-turn:cmd-1'
}
const COMMAND_TURN_KEY = agentJournalItemKey(COMMAND_TURN_IDENTITY)
const RUNNING = {
  kind: 'turn' as const,
  turnId: 'compact:cmd-1',
  state: 'running' as const,
  userItemId: 'orca:submission:cmd-1',
  requestedAt: 1,
  startedAt: 1
}
const COMMAND = {
  clientMessageId: 'cmd-1',
  turnId: RUNNING.turnId,
  identity: COMMAND_TURN_IDENTITY,
  resultIdentity: { provider: 'orca' as const, clientMessageId: 'command-result:cmd-1' },
  running: RUNNING
}
const ACCEPTED: StructuredAgentSessionSinkAdmission = { accepted: true }

type Written = { key: string; body: AgentJournalItemBody; turnScope?: AgentJournalTurnScope }

function recorder(refuseRevisions = 0) {
  const writes: Written[] = []
  const record = (
    identity: AgentJournalItemIdentity,
    body: AgentJournalItemBody,
    turnScope?: AgentJournalTurnScope
  ) => writes.push({ key: agentJournalItemKey(identity), body, turnScope })
  const commandTurn: AgentJournalItemBody = RUNNING
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the claim resolver reads only `itemBody`.
  const journal = {
    itemBody: (itemId: string) => (itemId === COMMAND_TURN_KEY ? commandTurn : null)
  } as unknown as StructuredAgentSessionRevisionJournal
  let refusals = refuseRevisions
  const sink: StructuredAgentSessionEventSink = {
    appendItem: (identity, body, options) => record(identity, body, options.turnScope),
    appendTombstone: () => {},
    publish: () => {},
    tryPublish: () => ACCEPTED,
    tryAppendItem: (identity, body, options) => {
      record(identity, body, options.turnScope)
      return ACCEPTED
    },
    appendLifecycleBatch: (_settlementId, mutations) => {
      for (const mutation of mutations) {
        if (mutation.kind === 'item') {
          record(mutation.identity, mutation.body, mutation.turnScope)
        }
      }
    },
    tryReviseResolvedItemAndPublish: (_bytes, resolve, options) => {
      if (refusals > 0) {
        refusals -= 1
        return { accepted: false, reason: 'backpressure' }
      }
      const resolved = resolve(journal)
      if (resolved) {
        record(resolved.identity, resolved.body, options.turnScope)
      }
      return ACCEPTED
    }
  }
  return { sink, writes }
}

function notification(
  method: string,
  params: Record<string, unknown>
): CodexStructuredSessionEvent {
  return {
    type: 'notification',
    sessionId: SESSION,
    threadId: THREAD,
    method,
    params: { threadId: THREAD, ...params }
  }
}

function harness(refuseRevisions = 0) {
  const tap = recorder(refuseRevisions)
  const translator = createCodexJournalTranslator({
    sink: tap.sink,
    sessionId: SESSION,
    primaryThreadId: () => THREAD
  })
  return {
    ...tap,
    translator,
    emit: (event: CodexStructuredSessionEvent) => translator.handle(event)
  }
}

const codexTurnRecords = (writes: readonly Written[]) =>
  writes.filter((write) => write.key !== COMMAND_TURN_KEY && readAgentJournalTurn(write.body))

const commandTurn = (writes: readonly Written[]) =>
  readAgentJournalTurn(writes.findLast((write) => write.key === COMMAND_TURN_KEY)?.body)

const resultRows = (writes: readonly Written[]) =>
  writes.filter((write) => write.body.kind === 'status')

describe('a Codex turn a conversation command claims', () => {
  it("ends a captured failed compaction on its completion, below one row of Codex's own", () => {
    // Captured app-server sequence: two retries, a fatal error, then failed completion.
    const captured: { case: string; t: number; method: string; params: object }[] = readFileSync(
      join(__dirname, '../../__fixtures__/codex-app-server-turn-endings.jsonl'),
      'utf8'
    )
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line))
      .filter((frame) => frame.case === '0.158.0-compact-overloaded')
    const compactionTurn = captured.findLastIndex((frame) => frame.method === 'turn/started')
    const { writes, translator, emit } = harness()
    translator.beginCommand(COMMAND)
    for (const frame of captured.slice(compactionTurn)) {
      emit({
        type: 'notification',
        sessionId: SESSION,
        threadId: THREAD,
        method: frame.method,
        params: { ...frame.params, threadId: THREAD },
        observedAt: frame.t
      })
    }

    expect(codexTurnRecords(writes)).toEqual([])
    const completion = captured.at(-1)!
    expect(completion.method).toBe('turn/completed')
    expect(commandTurn(writes)).toMatchObject({
      state: 'completed',
      outcome: 'failure',
      completedAt: completion.t
    })
    const scope = { kind: 'turn', turnItemId: COMMAND_TURN_KEY }
    const rows = resultRows(writes)
    expect(rows.map((write) => write.key)).not.toContain(
      agentJournalItemKey(COMMAND.resultIdentity)
    )
    expect(rows.map((write) => write.turnScope)).toEqual(rows.map(() => scope))
    expect(
      rows.some(
        (write) =>
          write.body.kind === 'status' &&
          write.body.tone === 'error' &&
          write.body.text.includes('Selected model is at capacity')
      )
    ).toBe(true)
  })

  it('leaves the next turn to write its own record after a failed compaction', () => {
    const { writes, translator, emit } = harness()
    translator.beginCommand(COMMAND)
    emit(notification('turn/started', { turn: { id: PROVIDER_TURN } }))
    emit(
      notification('error', { turnId: PROVIDER_TURN, willRetry: false, error: { message: 'x' } })
    )
    emit(notification('turn/completed', { turn: { id: PROVIDER_TURN, status: 'failed' } }))
    emit(notification('turn/started', { turn: { id: 'ordinary' } }))
    emit(notification('turn/completed', { turn: { id: 'ordinary', status: 'completed' } }))

    expect(
      codexTurnRecords(writes).map((write) => readAgentJournalTurn(write.body)?.turnId)
    ).toEqual(['ordinary', 'ordinary'])
  })

  it('names no provider turn for a Stop until Codex opens one, then the one it opened', () => {
    const { translator, emit } = harness()
    translator.beginCommand(COMMAND)
    expect(translator.commandProviderTurnId(COMMAND.turnId)).toBeUndefined()
    emit(notification('turn/started', { turn: { id: PROVIDER_TURN } }))
    expect(translator.commandProviderTurnId(COMMAND.turnId)).toBe(PROVIDER_TURN)
    expect(translator.commandProviderTurnId('ordinary')).toBe('ordinary')
  })

  it('claims the same provider turn when the refused start is retried', () => {
    const { writes, translator, emit } = harness(1)
    translator.beginCommand(COMMAND)
    const started = notification('turn/started', { turn: { id: PROVIDER_TURN } })

    expect(emit(started)).toEqual({ accepted: false, reason: 'backpressure' })
    expect(emit(started)).toEqual(ACCEPTED)

    expect(codexTurnRecords(writes)).toEqual([])
    expect(commandTurn(writes)).toMatchObject({ providerTurnId: PROVIDER_TURN })
    expect(translator.commandProviderTurnId(COMMAND.turnId)).toBe(PROVIDER_TURN)
  })
})
