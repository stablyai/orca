import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity,
  AgentJournalTurnScope
} from '../../shared/agent-session-journal-types'
import { readAgentJournalTurn } from '../../shared/agent-session-turn-record'
import type {
  StructuredAgentSessionEventSink,
  StructuredAgentSessionRevisionJournal,
  StructuredAgentSessionSinkAdmission
} from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { createCodexJournalTranslator } from './codex-structured-journal-translation'
import type { CodexStructuredSessionEvent } from './codex-structured-session-adapter'

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

/** Records every write with the scope it states; the journal holds the running command turn. */
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

/** Codex names the thread inside every notification's params too. */
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

/** The command turn's newest body, as the journal would hold it. */
const commandTurn = (writes: readonly Written[]) =>
  readAgentJournalTurn(writes.findLast((write) => write.key === COMMAND_TURN_KEY)?.body)

const resultRows = (writes: readonly Written[]) =>
  writes.filter((write) => write.body.kind === 'status')

describe('a Codex turn a conversation command claims', () => {
  it('is the command turn: writes no root turn, scopes its content there, and ends it', () => {
    const { writes, translator, emit } = harness()
    translator.beginCommand(COMMAND)

    emit(notification('turn/started', { turn: { id: PROVIDER_TURN } }))
    // The claim is persisted on the command turn: nothing else re-derives it later.
    expect(commandTurn(writes)).toMatchObject({ state: 'running', providerTurnId: PROVIDER_TURN })
    emit(
      notification('item/completed', {
        turnId: PROVIDER_TURN,
        item: { type: 'agentMessage', id: 'summary', text: 'Summary of the conversation.' }
      })
    )
    emit(
      notification('item/completed', {
        turnId: PROVIDER_TURN,
        item: { type: 'contextCompaction', id: 'compaction' }
      })
    )
    emit(notification('turn/completed', { turn: { id: PROVIDER_TURN, status: 'completed' } }))

    expect(codexTurnRecords(writes)).toEqual([])
    const scope = { kind: 'turn', turnItemId: COMMAND_TURN_KEY }
    const summary = writes.find(
      (write) => write.body.kind === 'message' && write.body.role === 'assistant'
    )
    expect(summary?.turnScope).toEqual(scope)
    // Codex's own marker is the command's result row.
    expect(resultRows(writes)).toEqual([
      expect.objectContaining({
        body: { kind: 'status', text: 'Context compacted', presentation: 'compaction' },
        turnScope: scope
      })
    ])
    expect(commandTurn(writes)).toMatchObject({
      state: 'completed',
      outcome: 'success',
      providerTurnId: PROVIDER_TURN,
      userItemId: RUNNING.userItemId,
      requestedAt: RUNNING.requestedAt
    })
  })

  it('reads an interrupted turn as the command cancelled, with no result row', () => {
    const { writes, translator, emit } = harness()
    translator.beginCommand(COMMAND)
    emit(notification('turn/started', { turn: { id: PROVIDER_TURN } }))
    emit(notification('turn/completed', { turn: { id: PROVIDER_TURN, status: 'interrupted' } }))

    expect(commandTurn(writes)).toMatchObject({ state: 'interrupted', outcome: 'cancellation' })
    expect(resultRows(writes)).toEqual([])
  })

  it('reads a turn that completed without compacting as a failure, with the reason', () => {
    const { writes, translator, emit } = harness()
    translator.beginCommand(COMMAND)
    emit(notification('turn/started', { turn: { id: PROVIDER_TURN } }))
    emit(
      notification('turn/completed', {
        turn: { id: PROVIDER_TURN, status: 'failed', error: { message: 'Unavailable' } }
      })
    )

    expect(commandTurn(writes)).toMatchObject({ state: 'completed', outcome: 'failure' })
    expect(resultRows(writes).map((write) => write.body)).toEqual([
      {
        kind: 'status',
        text: "Codex couldn't shorten this chat's history.",
        failure: {
          kind: 'compactionFailed',
          detail: { text: 'Unavailable', audience: 'log' }
        },
        tone: 'error'
      }
    ])
  })

  it('says only that the compaction failed when a turn that did not complete gave no words', () => {
    const { writes, translator, emit } = harness()
    translator.beginCommand(COMMAND)
    emit(notification('turn/started', { turn: { id: PROVIDER_TURN } }))
    emit(notification('turn/completed', { turn: { id: PROVIDER_TURN, status: 'failed' } }))

    expect(commandTurn(writes)).toMatchObject({ state: 'completed', outcome: 'failure' })
    expect(resultRows(writes).map((write) => write.body)).toEqual([
      {
        kind: 'status',
        text: "Codex couldn't shorten this chat's history.",
        failure: { kind: 'compactionFailed' },
        tone: 'error'
      }
    ])
  })

  it('reports a turn that completed without Codex reporting a compaction as unconfirmed', () => {
    const { writes, translator, emit } = harness()
    translator.beginCommand(COMMAND)
    emit(notification('turn/started', { turn: { id: PROVIDER_TURN } }))
    emit(notification('turn/completed', { turn: { id: PROVIDER_TURN, status: 'completed' } }))

    expect(commandTurn(writes)).toMatchObject({ state: 'completed', outcome: 'failure' })
    expect(resultRows(writes).map((write) => write.body)).toEqual([
      {
        kind: 'status',
        text: "Codex hasn't confirmed that this chat's history was shortened. Check the chat before running /compact again.",
        failure: { kind: 'compactionUnconfirmed' },
        tone: 'error'
      }
    ])
  })

  it('ends a compaction Codex failed with an error once, however late its completion', () => {
    const { writes, translator, emit } = harness()
    translator.beginCommand(COMMAND)
    emit(notification('turn/started', { turn: { id: PROVIDER_TURN } }))
    emit(
      notification('error', {
        turnId: PROVIDER_TURN,
        willRetry: false,
        error: { message: 'Unavailable' }
      })
    )
    // The error is a row; only the completion ends the turn.
    expect(commandTurn(writes)).toMatchObject({ state: 'running' })
    // Codex still completes the turn it failed, as status failed.
    emit(
      notification('turn/completed', {
        turn: { id: PROVIDER_TURN, status: 'failed', error: { message: 'Unavailable' } }
      })
    )

    expect(codexTurnRecords(writes)).toEqual([])
    expect(commandTurn(writes)).toMatchObject({ state: 'completed', outcome: 'failure' })
    expect(
      writes.filter(
        (write) => write.key === COMMAND_TURN_KEY && readAgentJournalTurn(write.body)?.completedAt
      )
    ).toHaveLength(1)
    // Codex's own error row, in the command's turn; the completion adds none.
    expect(resultRows(writes)).toEqual([
      expect.objectContaining({
        body: expect.objectContaining({
          kind: 'status',
          text: 'Codex ran into a problem. Check the chat before trying again.',
          tone: 'error',
          failure: { kind: 'providerError', detail: { text: 'Unavailable', audience: 'log' } }
        }),
        turnScope: { kind: 'turn', turnItemId: COMMAND_TURN_KEY }
      })
    ])
  })

  it("ends a captured failed compaction on its completion, below one row of Codex's own", () => {
    // A real app-server's compaction turn: two retried stream errors, the turn-ending error, then
    // the failed completion.
    const captured: { case: string; t: number; method: string; params: object }[] = readFileSync(
      join(__dirname, '__fixtures__', 'codex-app-server-turn-endings.jsonl'),
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
    // Every row is one of Codex's frames, inside the command's turn; the completion adds none.
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

  it('leaves a primary turn no command claims to write its own record', () => {
    const { writes, translator, emit } = harness()
    translator.beginCommand(COMMAND)
    translator.forgetCommand(COMMAND.turnId)
    emit(notification('turn/started', { turn: { id: 'ordinary' } }))
    emit(notification('turn/completed', { turn: { id: 'ordinary', status: 'completed' } }))
    expect(
      codexTurnRecords(writes).map((write) => readAgentJournalTurn(write.body)?.state)
    ).toEqual(['running', 'completed'])
  })
})
