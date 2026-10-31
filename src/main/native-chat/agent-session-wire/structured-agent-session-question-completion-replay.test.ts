import { afterEach, expect, it, vi } from 'vitest'
import {
  agentJournalItemKey,
  agentJournalSubmissionKey,
  parseAgentJournalItemKey
} from '../../../shared/agent-session-journal-item-key'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemBody,
  type AgentJournalRenderItem
} from '../../../shared/agent-session-journal-types'
import { agentJournalLinkageFields } from '../../../shared/agent-session-journal-producer'
import { currentMessageQuestionView } from '../../../shared/agent-session-current-requests'
import { messageQuestionOccurrenceSchema } from '../../../shared/message-question-occurrence'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import { insertJournalRow } from '../agent-session-journal/journal-row-table'
import { journalRowBase } from '../agent-session-journal/journal-row-builders'
import { failQuestionSettlement } from '../message-question-settlement-failure.test-fixture'
import { asyncQuestionBody } from './structured-agent-session-async-question.test-fixture'
import {
  currentJournal,
  currentWork
} from './structured-agent-session-leftover-settlement.test-fixture'
import { observeAsyncQuestions } from './structured-agent-session-question-observation.test-fixture'
import {
  createQueuedMessageTestRig,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'
import {
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD,
  HOST_TEST_NOW
} from './structured-agent-session-host-test-data'
import type { JournalQuestionInput } from '../agent-session-journal/journal-question-source'

let rig: QueuedMessageTestRig | undefined
let restore: (() => void) | undefined
afterEach(async () => {
  restore?.()
  restore = undefined
  await rig?.dispose()
  rig = undefined
  vi.restoreAllMocks()
})

function visible(items: readonly AgentJournalRenderItem[]) {
  return items.map(({ itemId, body, turnScope, ...item }) => ({
    itemId,
    body,
    turnScope,
    ...agentJournalLinkageFields(item)
  }))
}

function semanticInputs(inputs: readonly JournalQuestionInput[]) {
  return inputs.map((input) =>
    input.kind === 'remove'
      ? { kind: input.kind, itemId: input.itemId, at: input.at }
      : {
          kind: input.kind,
          item: visible([input.item])[0],
          at: input.item.observedAt,
          unsent: input.unsent
        }
  )
}

it.each([
  { owner: 'epoch', shape: 'turn', failure: 'update' },
  { owner: 'context', shape: 'status', failure: 'commit' }
] as const)(
  'keeps ordinary completion before unscoped Q through cold repeated replacement: %o',
  async ({ owner, shape, failure }) => {
    rig = await createQueuedMessageTestRig({ restartable: true })
    const current = rig
    await current.host.history({ sessionId: SESSION, direction: 'tail' })
    let journal = currentJournal(current)
    const fence = current.store.getRecord(SESSION)!.lease.runtimeFence
    if (owner === 'context') {
      await journal.context.clear(
        { operationId: 'completion-context', afterFence: fence, clearedAt: HOST_TEST_NOW },
        { write: () => {}, committed: () => {} }
      )
    }
    const rootIdentity = {
      provider: 'codex' as const,
      threadId: THREAD,
      turnId: 'ordinary-root',
      ordinal: 0
    }
    const rootId = agentJournalItemKey(rootIdentity)
    const questionIdentity = { ...rootIdentity, ordinal: 1 }
    const questionId = agentJournalItemKey(questionIdentity)
    const turnBody = (state: 'running' | 'completed'): AgentJournalItemBody =>
      shape === 'turn'
        ? { kind: 'turn', turnId: 'ordinary-root', state }
        : { kind: 'status', text: state, turnLifecycle: { turnId: 'ordinary-root', state } }
    const question = asyncQuestionBody('after ordinary completion')
    const database = openTestJournalHostDatabase(current.root)
    const cursor = journal.cursor()
    // Seed admitted saved legacy rows; the production cold reader must derive their absent scopes.
    await journal.readInOrder(() =>
      database.transaction((db) => {
        const rows = [
          { itemId: rootId, revision: 1, body: turnBody('running') },
          { itemId: rootId, revision: 2, body: turnBody('completed') },
          { itemId: questionId, revision: 1, body: question }
        ]
        rows.forEach((row, index) =>
          insertJournalRow(db, SESSION, {
            ...journalRowBase(cursor.epoch, cursor.sequence + index + 1, fence, HOST_TEST_NOW, [
              row.body
            ]),
            kind: 'item',
            ...row
          })
        )
      })
    )
    await current.restartHostProcess()
    await current.host.history({ sessionId: SESSION, direction: 'tail' })
    journal = currentJournal(current)
    expect(journal.item(questionId)?.turnScope).toEqual(AGENT_JOURNAL_THREAD_SCOPE)
    const project = () =>
      currentWork(current).requestProjection(SESSION, 'agent-session.current-requests.v2')
    project()
    const ownerSource = journal.messageQuestions()
    const target = ownerSource.repository
      .current(ownerSource.source)
      .records.find((record) => record.sourceRowId === questionId)!
    expect(target.resolution.state).toBe('pending')
    const saved = () => {
      const row = database.db
        .prepare('SELECT record_json FROM message_question_occurrences WHERE occurrence_id = ?')
        .get(target.id)
      return messageQuestionOccurrenceSchema.parse(JSON.parse(String(row?.record_json)))
    }
    const fault = failQuestionSettlement(database.db, target.id, failure)
    restore = fault.restore
    const stopped: AgentJournalItemBody = {
      kind: 'turn',
      turnId: 'ordinary-root',
      state: 'interrupted',
      outcome: 'cancellation',
      completedAt: HOST_TEST_NOW
    }
    await journal.appendItem(
      rootIdentity,
      shape === 'turn'
        ? stopped
        : {
            kind: 'status',
            text: 'Interrupted',
            turnLifecycle: {
              turnId: 'ordinary-root',
              state: 'interrupted',
              outcome: 'cancellation',
              completedAt: HOST_TEST_NOW
            }
          },
      { fence }
    )
    const answer = await journal.appendItem(
      { ...rootIdentity, turnId: 'ordinary-human', ordinal: 0 },
      {
        kind: 'message',
        role: 'user',
        blocks: [{ type: 'text', text: 'direct old-client answer α🙂' }]
      },
      { fence, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    project()
    expect(saved().resolution.state).toBe('pending')
    const originalInputs = semanticInputs(journal.questionSourceFacts().inputs)
    const clearId = agentJournalSubmissionKey('context-clear:completion-context')
    expect(
      originalInputs.map((input) => (input.kind === 'item' ? input.item.itemId : input.itemId))
    ).toEqual([
      ...(owner === 'context' ? [clearId] : []),
      rootId,
      rootId,
      questionId,
      rootId,
      answer.itemId
    ])
    const floor = owner === 'context' ? journal.context.floor() : null
    expect(Boolean(floor)).toBe(owner === 'context')
    const cut = () => {
      const currentFloor = journal.context.floor()
      return journal
        .snapshot()
        .items.filter((item) => !currentFloor || item.sequence > currentFloor.sequence)
    }
    const expectedView = visible(cut())
    for (let replacement = 0; replacement < 2; replacement++) {
      const items = cut().map((item) => ({
        identity: parseAgentJournalItemKey(item.itemId)!,
        body: item.body,
        turnScope: item.turnScope,
        observedAt: item.observedAt,
        ownerFence: journal.itemFence(item.itemId) ?? fence,
        ...agentJournalLinkageFields(item)
      }))
      const beforeEpoch = journal.epoch
      await (owner === 'context'
        ? journal.context.rewind(floor!, fence, items, () => ({
            write: () => {},
            committed: () => {}
          }))
        : journal.replaceEpochItems('handle_forked', fence, items))
      expect(journal.epoch === beforeEpoch).toBe(owner === 'context')
      expect(visible(cut())).toEqual(expectedView)
      await current.restartHostProcess()
      await current.host.history({ sessionId: SESSION, direction: 'tail' })
      journal = currentJournal(current)
      expect(semanticInputs(journal.questionSourceFacts().inputs)).toEqual(originalInputs)
      expect(journal.item(questionId)?.turnScope).toEqual(AGENT_JOURNAL_THREAD_SCOPE)
      expect(visible(cut())).toEqual(expectedView)
      project()
      expect(saved().resolution.state).toBe('pending')
    }
    let finalInputs = originalInputs
    if (owner === 'context') {
      // A later destructive owner must carry the same evidence left by context-floor rewrites.
      for (let transfer = 0; transfer < 2; transfer++) {
        const beforeReplacement = Date.now()
        await journal.replaceEpochItems(
          'handle_forked',
          fence,
          cut().map((item) => ({
            identity: parseAgentJournalItemKey(item.itemId)!,
            body: item.body,
            turnScope: item.turnScope,
            observedAt: item.observedAt,
            ownerFence: journal.itemFence(item.itemId) ?? fence,
            ...agentJournalLinkageFields(item)
          }))
        )
        const afterReplacement = Date.now()
        if (transfer === 0) {
          const firstTransfer = semanticInputs(journal.questionSourceFacts().inputs)
          expect(firstTransfer.slice(0, originalInputs.length)).toEqual(originalInputs)
          expect(firstTransfer).toHaveLength(originalInputs.length + 1)
          const removal = firstTransfer[originalInputs.length]
          if (removal?.kind !== 'remove') {
            throw new Error('Expected genuine clear-divider removal')
          }
          expect(removal.at).toBeGreaterThanOrEqual(beforeReplacement)
          expect(removal.at).toBeLessThanOrEqual(afterReplacement)
          finalInputs = [...originalInputs, { kind: 'remove', itemId: clearId, at: removal.at }]
          expect(firstTransfer).toEqual(finalInputs)
        }
        await current.restartHostProcess()
        await current.host.history({ sessionId: SESSION, direction: 'tail' })
        journal = currentJournal(current)
        expect(semanticInputs(journal.questionSourceFacts().inputs)).toEqual(finalInputs)
        expect(visible(cut())).toEqual(expectedView)
        project()
        expect(saved().resolution.state).toBe('pending')
      }
    }
    if (failure === 'commit') {
      expect(fault.failedCommits()).toBeGreaterThan(0)
    }
    fault.restore()
    restore = undefined
    const observed = await observeAsyncQuestions(current, 'completion-storage-recovery')
    try {
      await vi.waitFor(
        () => expect(currentMessageQuestionView(observed.state())?.ready).toBe(true),
        { timeout: 10_000 }
      )
      expect(saved()).toMatchObject({
        id: target.id,
        questions: target.questions,
        resolution: { state: 'resolved', reason: 'delivery', factId: answer.itemId }
      })
      expect(observed.state().asyncQuestions).toEqual([])
    } finally {
      observed.close()
    }
    await current.restartHostProcess()
    await current.host.history({ sessionId: SESSION, direction: 'tail' })
    expect(semanticInputs(currentJournal(current).questionSourceFacts().inputs)).toEqual(
      finalInputs
    )
    expect(saved().resolution).toMatchObject({
      state: 'resolved',
      reason: 'delivery',
      factId: answer.itemId
    })
  }
)
