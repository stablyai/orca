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
import { StructuredSessionCompaction } from '../native-chat/agent-session-wire/structured-session-compaction'
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
const COMMAND = { turnId: 'compact:cmd-1', turnItemId: COMMAND_TURN_KEY }
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
  const commandTurn: AgentJournalItemBody = {
    kind: 'turn',
    turnId: COMMAND.turnId,
    state: 'running',
    startedAt: 1
  }
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
function notification(method: string, params: object): CodexStructuredSessionEvent {
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
  const tracker = new StructuredSessionCompaction()
  const translator = createCodexJournalTranslator({
    sink: tap.sink,
    sessionId: SESSION,
    primaryThreadId: () => THREAD,
    claimCommandTurn: (threadId, turnId) => tracker.claimTurn(SESSION, threadId, turnId)
  })
  // The adapter's order: the translator journals first, the tracker observes second.
  const emit = (event: CodexStructuredSessionEvent) => {
    const admission = translator.handle(event)
    if (admission.accepted && event.type === 'notification') {
      tracker.codex(event.sessionId, event.method, event.params)
    }
    return admission
  }
  return { ...tap, tracker, emit }
}

const codexTurnRecords = (writes: readonly Written[]) =>
  writes.filter((write) => write.key !== COMMAND_TURN_KEY && readAgentJournalTurn(write.body))

describe('a Codex turn a conversation command claims', () => {
  it('writes one root turn — the command turn — and scopes its content to it', async () => {
    const { writes, tracker, emit } = harness()
    const completion = tracker.run(SESSION, THREAD, async () => ({}), COMMAND)
    await Promise.resolve()

    emit(notification('turn/started', { turn: { id: PROVIDER_TURN } }))
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
    // The claim is persisted on the command turn: nothing else re-derives it later.
    expect(writes.find((write) => write.key === COMMAND_TURN_KEY)?.body).toMatchObject({
      kind: 'turn',
      state: 'running',
      providerTurnId: PROVIDER_TURN
    })
    const summary = writes.find(
      (write) => write.body.kind === 'message' && write.body.role === 'assistant'
    )
    expect(summary?.turnScope).toEqual({ kind: 'turn', turnItemId: COMMAND_TURN_KEY })
    expect(
      writes.some(
        (write) => write.body.kind === 'status' && write.body.text === 'Context compacted'
      )
    ).toBe(false)
    await expect(completion).resolves.toEqual({ outcome: 'success' })
  })

  it('claims the same provider turn when the refused start is retried', async () => {
    const { writes, tracker, emit } = harness(1)
    void tracker.run(SESSION, THREAD, async () => ({}), COMMAND)
    await Promise.resolve()
    const started = notification('turn/started', { turn: { id: PROVIDER_TURN } })

    expect(emit(started)).toEqual({ accepted: false, reason: 'backpressure' })
    expect(emit(started)).toEqual(ACCEPTED)

    expect(codexTurnRecords(writes)).toEqual([])
    expect(writes.find((write) => write.key === COMMAND_TURN_KEY)?.body).toMatchObject({
      providerTurnId: PROVIDER_TURN
    })
    expect(tracker.providerTurnId(SESSION, COMMAND.turnId)).toBe(PROVIDER_TURN)
  })

  it('leaves a primary turn no command claims to write its own record', () => {
    const { writes, emit } = harness()
    emit(notification('turn/started', { turn: { id: 'ordinary' } }))
    emit(notification('turn/completed', { turn: { id: 'ordinary', status: 'completed' } }))
    expect(
      codexTurnRecords(writes).map((write) => readAgentJournalTurn(write.body)?.state)
    ).toEqual(['running', 'completed'])
  })
})
