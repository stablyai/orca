import { activeProviderContext } from '../../../shared/agent-session-provider-context'
import { afterEach, expect, it, vi } from 'vitest'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalRenderItem
} from '../../../shared/agent-session-journal-types'
import {
  agentJournalItemKey,
  agentJournalSubmissionKey,
  parseAgentJournalItemKey
} from '../../../shared/agent-session-journal-item-key'
import { agentJournalLinkageFields } from '../../../shared/agent-session-journal-producer'
import { messageQuestionOccurrenceSchema } from '../../../shared/message-question-occurrence'
import { currentMessageQuestionView } from '../../../shared/agent-session-current-requests'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import { failQuestionSettlement } from '../message-question-settlement-failure.test-fixture'
import { MessageQuestionIngest } from '../message-question-ingest'
import { JournalQuestionSource } from '../agent-session-journal/journal-question-source'
import {
  currentJournal,
  currentWork
} from './structured-agent-session-leftover-settlement.test-fixture'
import { asyncQuestionBody } from './structured-agent-session-async-question.test-fixture'
import { observeAsyncQuestions } from './structured-agent-session-question-observation.test-fixture'
import { recoverStructuredRewind } from './structured-rewind-recovery'
import { structuredRewindCut } from './structured-rewind-cut'
import {
  createQueuedMessageTestRig,
  QUEUED_RIG_CALLER as CALLER,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'
import {
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD,
  hostTestOperationId
} from './structured-agent-session-host-test-data'

let rig: QueuedMessageTestRig | undefined
let releaseFailure: (() => void) | undefined
afterEach(async () => {
  releaseFailure?.()
  releaseFailure = undefined
  await rig?.dispose()
  rig = undefined
  vi.restoreAllMocks()
})

function saved(target: string) {
  const row = openTestJournalHostDatabase(rig!.root)
    .db.prepare('SELECT record_json FROM message_question_occurrences WHERE occurrence_id = ?')
    .get(target)
  return messageQuestionOccurrenceSchema.parse(JSON.parse(String(row?.record_json)))
}

async function clear(current: QueuedMessageTestRig) {
  const fields = { command: 'clear' as const }
  expect(
    await current.host.conversationCommand(CALLER, {
      ...fields,
      envelope: current.envelope(fields, 'agentSession.conversationCommand', hostTestOperationId())
    })
  ).toMatchObject({ ok: true })
}

async function accepted(current: QueuedMessageTestRig, text: string, turn: string) {
  const sent = current.send(text)
  expect(await sent.result).toMatchObject({ ok: true })
  await vi.waitFor(async () =>
    expect((await current.submission(sent.id))?.handedOverAt).toBeDefined()
  )
  await current.settleAccepted(sent.id, turn)
  return agentJournalSubmissionKey(sent.id)
}

function visible(items: readonly AgentJournalRenderItem[]) {
  return items.map(({ itemId, body, turnScope, ...item }) => ({
    itemId,
    body,
    turnScope,
    ...agentJournalLinkageFields(item)
  }))
}

it.each([
  { owner: 'epoch', first: 'delivery', failure: 'q2', remove: 'none' },
  { owner: 'context', first: 'delivery', failure: 'q2', remove: 'question' },
  { owner: 'epoch', first: 'delivery', failure: 'update', remove: 'answer' },
  { owner: 'context', first: 'stop', failure: 'update', remove: 'question' },
  { owner: 'epoch', first: 'stop', failure: 'commit', remove: 'answer' },
  { owner: 'context', first: 'stop', failure: 'commit', remove: 'none' },
  { owner: 'epoch', first: 'pending', failure: 'q2', remove: 'question' },
  { owner: 'context', first: 'pending', failure: 'update', remove: 'question' }
] as const)(
  'reconstructs exact first terminal without gating Send/rewind: %o',
  async ({ owner, first, failure, remove }) => {
    const rewind = vi.fn(async () => ({ ok: true as const }))
    rig = await createQueuedMessageTestRig({ restartable: true, rewind })
    const current = rig
    const seed = await current.workingSend()
    await current.settleAccepted(seed, 'seed')
    if (owner === 'context') {
      await clear(current)
      const afterClear = await current.workingSend()
      await current.settleAccepted(afterClear, 'after-clear')
      expect(activeProviderContext(current.store.getRecord(SESSION)!).head).not.toBeNull()
    }
    const journal = currentJournal(current)
    const thread = activeProviderContext(current.store.getRecord(SESSION)!).head!.handle.nativeId
    const identity = { provider: 'codex' as const, threadId: thread, turnId: 'T1', ordinal: 1 }
    const fence = current.store.getRecord(SESSION)!.lease.runtimeFence
    const root = await journal.appendItem(
      identity,
      { kind: 'turn', turnId: 'T1', state: 'running' },
      { fence }
    )
    const scope = { kind: 'turn' as const, turnItemId: root.itemId }
    const q1 = await journal.appendItem({ ...identity, ordinal: 2 }, asyncQuestionBody('Q1'), {
      fence,
      turnScope: scope
    })
    const projection = () =>
      currentWork(current).requestProjection(SESSION, 'agent-session.current-requests.v2').items
    projection()
    const source = journal.messageQuestions()
    const target = source.repository
      .current(source.source)
      .records.find((record) => record.sourceRowId === q1.itemId)!.id
    expect(saved(target).resolution.state).toBe('pending')
    const fault = failQuestionSettlement(
      openTestJournalHostDatabase(current.root).db,
      target,
      failure
    )
    releaseFailure = fault.restore
    const q2 = await journal.appendItem({ ...identity, ordinal: 3 }, asyncQuestionBody('Q2'), {
      fence,
      turnScope: scope
    })
    projection()
    if (failure !== 'q2') {
      expect(
        source.repository
          .current(source.source)
          .records.some((record) => record.sourceRowId === q2.itemId)
      ).toBe(true)
    }
    let answer: string | undefined
    const stop = () =>
      journal.appendItem(
        identity,
        {
          kind: 'turn',
          turnId: 'T1',
          state: 'interrupted',
          outcome: 'cancellation',
          completedAt: 1
        },
        { fence }
      )
    if (first === 'stop') {
      await stop()
    }
    if (first !== 'pending') {
      answer = await accepted(current, 'original submitted Unicode answer α🙂', 'answer')
      const submission = journal
        .submissions()
        .find((entry) => agentJournalSubmissionKey(entry.clientMessageId) === answer)!
      const provider = parseAgentJournalItemKey(submission.providerItemId!)!
      await journal.appendItem(
        provider,
        {
          kind: 'message',
          role: 'user',
          blocks: [{ type: 'text', text: 'provider normalized text' }]
        },
        { fence }
      )
      expect(journal.item(answer)?.body).toMatchObject({
        blocks: [{ text: 'original submitted Unicode answer α🙂' }]
      })
    }
    if (first === 'delivery' || first === 'pending') {
      if (first === 'pending') {
        // Real removal precedes any later prompt delivery; no fabricated timestamp orders it.
        await journal.appendTombstone({ ...identity, ordinal: 2 }, { fence })
      }
      await stop()
    }
    if (remove === 'question' && first !== 'pending') {
      await journal.appendTombstone({ ...identity, ordinal: 2 }, { fence })
    }
    if (remove === 'answer') {
      const key = parseAgentJournalItemKey(answer!)!
      await journal.appendTombstone(key, { fence })
    }
    projection()
    expect(saved(target).resolution.state).toBe('pending')
    const next = await accepted(current, 'later T2 rewind opener', 'target')
    const expectedEpoch = journal.cursor().epoch
    const fields = { itemId: next, expectedEpoch }
    const cut = structuredRewindCut(journal, { itemId: next, provider: 'codex', nativeId: thread })!
    expect(cut).not.toBeNull()
    const expectedView = cut.kept.map((item) => ({
      itemId: agentJournalItemKey(item.identity),
      body: item.body,
      turnScope: item.turnScope,
      ...agentJournalLinkageFields(item)
    }))
    expect(
      await current.host.rewind(CALLER, {
        ...fields,
        envelope: current.envelope(fields, 'agentSession.rewind', hostTestOperationId())
      })
    ).toMatchObject({ ok: true })
    expect(rewind).toHaveBeenCalledOnce()
    expect(journal.cursor().epoch === expectedEpoch).toBe(owner === 'context')
    const floor = journal.context.floor()
    expect(
      visible(journal.snapshot().items.filter((item) => !floor || item.sequence > floor.sequence))
    ).toEqual(expectedView)
    expect(saved(target).resolution.state).toBe('pending')
    if (owner === 'context') {
      const another = await accepted(
        current,
        'later T3 opener for the same context owner',
        'target-again'
      )
      const fields = { itemId: another, expectedEpoch: journal.cursor().epoch }
      expect(
        await current.host.rewind(CALLER, {
          ...fields,
          envelope: current.envelope(fields, 'agentSession.rewind', hostTestOperationId())
        })
      ).toMatchObject({ ok: true })
      expect(saved(target).resolution.state).toBe('pending')
      expect(journal.cursor().epoch).toBe(expectedEpoch)
    }
    const providerEffects = owner === 'context' ? 2 : 1
    const expected =
      first === 'pending'
        ? { state: 'cancelled', reason: 'source-replaced', factId: q1.itemId }
        : first === 'delivery'
          ? { state: 'resolved', reason: 'delivery', factId: answer }
          : { state: 'cancelled', reason: 'interruption', factId: root.itemId }
    // Cold ownership, no observer or successful Cancel, while the original write failure still holds.
    await current.restartHostProcess()
    await current.host.history({ sessionId: SESSION, direction: 'tail' })
    const cold = currentJournal(current)
    const snapshot = cold.snapshot()
    const beforeInputs = cold.questionSourceFacts().inputs.length
    const replacement = snapshot.items.map((item) => ({
      identity: parseAgentJournalItemKey(item.itemId)!,
      body: item.body,
      observedAt: item.observedAt,
      turnScope: item.turnScope,
      ownerFence: cold.itemFence(item.itemId) ?? fence,
      ...agentJournalLinkageFields(item)
    }))
    await cold.replaceEpochItems('handle_forked', fence, replacement)
    const firstRows = cold.readSince({ epoch: cold.epoch, sequence: 0 })
    expect(firstRows.ok).toBe(true)
    await cold.replaceEpochItems('handle_forked', fence, replacement)
    const secondRows = cold.readSince({ epoch: cold.epoch, sequence: 0 })
    expect(secondRows.ok && secondRows.rows.length).toBe(firstRows.ok && firstRows.rows.length)
    expect(cold.questionSourceFacts().inputs).toHaveLength(beforeInputs)
    expect(saved(target).resolution.state).toBe('pending')
    if (failure === 'commit') {
      expect(fault.failedCommits()).toBeGreaterThan(0)
    }
    fault.restore()
    releaseFailure = undefined
    const observed = await observeAsyncQuestions(current, 'storage-only-recovery')
    try {
      await vi.waitFor(
        () => expect(currentMessageQuestionView(observed.state())?.ready).toBe(true),
        { timeout: 10_000 }
      )
      expect(saved(target)).toMatchObject({ id: target, resolution: expected })
    } finally {
      observed.close()
    }
    await current.restartHostProcess()
    await current.host.history({ sessionId: SESSION, direction: 'tail' })
    expect(saved(target).resolution).toMatchObject(expected)
    expect(rewind).toHaveBeenCalledTimes(providerEffects)
  }
)

it.each(['before', 'after'] as const)(
  'recovers a %s-canonical-commit crash without a second provider effect',
  async (side) => {
    const rewind = vi.fn(async () => ({ ok: true as const }))
    rig = await createQueuedMessageTestRig({ restartable: true, rewind })
    const current = rig
    const seed = await current.workingSend()
    await current.settleAccepted(seed, 'kept')
    const journal = currentJournal(current)
    await journal.appendItem(
      { provider: 'codex', threadId: THREAD, turnId: 'turn-kept', ordinal: 2 },
      asyncQuestionBody('kept'),
      { fence: 1 }
    )
    currentWork(current).requestProjection(SESSION, 'agent-session.current-requests.v2')
    const owner = journal.messageQuestions()
    const target = owner.repository.current(owner.source).records[0].id
    const fault = failQuestionSettlement(
      openTestJournalHostDatabase(current.root).db,
      target,
      'update'
    )
    releaseFailure = fault.restore
    const next = await accepted(current, 'next', 'target')
    const before = journal.snapshot()
    const transition = current.store.transitionHandoff.bind(current.store)
    const db = openTestJournalHostDatabase(current.root).db
    if (side === 'before') {
      db.exec(`CREATE TEMP TRIGGER fail_canonical_transfer BEFORE INSERT ON journal_rows
      WHEN json_extract(NEW.row_json, '$.replayRole') = 'source-only'
      BEGIN SELECT RAISE(ABORT, 'canonical transfer interrupted'); END`)
    }
    const commit =
      side === 'after'
        ? vi.spyOn(current.store, 'transitionHandoff').mockImplementation((sessionId, update) =>
            transition(sessionId, (record) => {
              const value = update(record)
              if (value.rewind?.phase === 'completed') {
                throw new Error('canonical transfer interrupted')
              }
              return value
            })
          )
        : undefined
    const fields = { itemId: next, expectedEpoch: before.cursor.epoch }
    await expect(
      current.host.rewind(CALLER, {
        ...fields,
        envelope: current.envelope(fields, 'agentSession.rewind', hostTestOperationId())
      })
    ).rejects.toThrow('canonical transfer interrupted')
    const committed = journal.snapshot()
    expect(committed.cursor.epoch === before.cursor.epoch).toBe(side === 'before')
    if (side === 'before') {
      expect(committed).toEqual(before)
    }
    commit?.mockRestore()
    if (side === 'before') {
      db.exec('DROP TRIGGER fail_canonical_transfer')
    }
    await recoverStructuredRewind(
      current.host.deps,
      SESSION,
      journal,
      current.store.getRecord(SESSION)!.lease.runtimeFence
    )
    expect(rewind).toHaveBeenCalledOnce()
    fault.restore()
    releaseFailure = undefined
    const observed = await observeAsyncQuestions(current, 'crash-storage-recovery')
    try {
      await vi.waitFor(
        () => expect(currentMessageQuestionView(observed.state())?.ready).toBe(true),
        { timeout: 10_000 }
      )
      expect(saved(target).resolution).toMatchObject({
        state: 'resolved',
        reason: 'delivery',
        factId: next
      })
    } finally {
      observed.close()
    }
  }
)

it.each([10, 100])(
  'keeps source evidence finite over repeated rewrites/output/view reads at N=%i',
  async (count) => {
    rig = await createQueuedMessageTestRig({
      restartable: true,
      rewind: async () => ({ ok: true })
    })
    const current = rig
    const seed = await current.workingSend()
    await current.settleAccepted(seed, 'seed')
    let journal = currentJournal(current)
    for (let index = 0; index < count; index++) {
      await journal.appendItem(
        { provider: 'codex', threadId: THREAD, turnId: 'questions', ordinal: index },
        asyncQuestionBody(`q-${index}`),
        { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
      )
    }
    const items = journal.snapshot().items.map((item) => ({
      identity: parseAgentJournalItemKey(item.itemId)!,
      body: item.body,
      turnScope: item.turnScope,
      ownerFence: 1
    }))
    const expectedDefinitionBytes = items.reduce(
      (bytes, item) =>
        bytes +
        (item.body.kind === 'message' && item.body.role === 'assistant'
          ? Buffer.byteLength(JSON.stringify(item.body))
          : 0),
      0
    )
    await journal.replaceEpochItems('handle_forked', 1, items)
    const extent = journal.questionSourceFacts().inputs.length
    for (let index = 0; index < 3; index++) {
      await journal.replaceEpochItems('handle_forked', 1, items)
      expect(journal.questionSourceFacts().inputs).toHaveLength(extent)
      const delta = journal.readSince({ epoch: journal.epoch, sequence: 0 })
      expect(delta.ok && delta.rows.length).toBeLessThanOrEqual(2 * count + 12)
    }
    const sourceReads = vi.spyOn(JournalQuestionSource.prototype, 'observe')
    await current.restartHostProcess()
    await current.host.history({ sessionId: SESSION, direction: 'tail' })
    journal = currentJournal(current)
    expect(sourceReads.mock.calls.length).toBeGreaterThanOrEqual(count)
    expect(sourceReads.mock.calls.length).toBeLessThanOrEqual(count + 12)
    const definitionBytes = sourceReads.mock.calls.reduce(
      (bytes, [row]) =>
        bytes +
        (row.kind === 'item' && row.body.kind === 'message' && row.body.role === 'assistant'
          ? Buffer.byteLength(JSON.stringify(row.body))
          : 0),
      0
    )
    expect(definitionBytes).toBe(expectedDefinitionBytes)
    sourceReads.mockClear()
    const projection = () =>
      currentWork(current).requestProjection(SESSION, 'agent-session.current-requests.v2').items
    const initial = projection()
    const append = vi.spyOn(MessageQuestionIngest.prototype, 'append')
    const attempts = vi.spyOn(journal.messageQuestions().repository, 'reconcile')
    for (let index = 0; index < 20; index++) {
      await journal.appendItem(
        { provider: 'codex', threadId: THREAD, turnId: 'output', ordinal: 0 },
        {
          kind: 'message',
          role: 'assistant',
          blocks: [{ type: 'text', text: `irrelevant ${index}` }]
        },
        { fence: 1 }
      )
      expect(projection()).toBe(initial)
    }
    expect(append).not.toHaveBeenCalled()
    expect(attempts).not.toHaveBeenCalled()
    expect(sourceReads).toHaveBeenCalledTimes(20)
    expect(journal.questionSourceFacts().inputs).toHaveLength(extent)
  }
)

it('revises the same canonical slots without reminting duplicates, and retains delivery after both rows disappear', async () => {
  rig = await createQueuedMessageTestRig({ restartable: true })
  const current = rig
  const start = await current.workingSend()
  await current.settleAccepted(start, 'start')
  let journal = currentJournal(current)
  const identity = {
    provider: 'codex' as const,
    threadId: THREAD,
    turnId: 'definitions',
    ordinal: 1
  }
  await journal.appendItem(
    identity,
    {
      kind: 'message',
      role: 'assistant',
      blocks: [{ type: 'text', text: 'output before a question is declared' }]
    },
    { fence: 1, agentId: 'child', turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
  const first = asyncQuestionBody('first')
  const second = asyncQuestionBody('second')
  const third = asyncQuestionBody('third')
  await journal.appendItem(
    identity,
    { ...first, blocks: [...first.blocks, ...first.blocks, ...second.blocks] },
    { fence: 1 }
  )
  const read = () => {
    currentWork(current).requestProjection(SESSION, 'agent-session.current-requests.v2')
    const owner = journal.messageQuestions()
    return owner.repository
      .current(owner.source)
      .records.filter((record) => record.sourceRowId === agentJournalItemKey(identity))
  }
  const before = read()
  expect(before.map((record) => record.callSlot)).toEqual([0, 2])
  await journal.appendItem(
    identity,
    { ...first, blocks: [...first.blocks, ...first.blocks, ...second.blocks, ...third.blocks] },
    { fence: 1 }
  )
  const revised = read()
  expect(revised.map((record) => record.callSlot)).toEqual([0, 2, 3])
  expect(revised.slice(0, 2).map((record) => record.id)).toEqual(before.map((record) => record.id))
  const answer = await journal.appendItem(
    { ...identity, turnId: 'direct-answer', ordinal: 0 },
    {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: 'ordinary old-client/direct-terminal answer' }]
    },
    { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
  await journal.appendTombstone(identity, { fence: 1 })
  await journal.appendTombstone({ ...identity, turnId: 'direct-answer', ordinal: 0 }, { fence: 1 })
  await journal.replaceEpochItems('handle_forked', 1, [])
  await current.restartHostProcess()
  await current.host.history({ sessionId: SESSION, direction: 'tail' })
  journal = currentJournal(current)
  const definitions = journal
    .questionSourceFacts()
    .inputs.filter(
      (input) => input.kind === 'item' && input.item.itemId === agentJournalItemKey(identity)
    )
  expect(definitions).toHaveLength(2)
  expect(
    definitions.every((input) => input.kind === 'item' && input.item.agentId === 'child')
  ).toBe(true)
  const result = read()
  expect(result.map((record) => record.id)).toEqual(revised.map((record) => record.id))
  expect(result.map((record) => record.resolution)).toEqual(
    revised.map(() =>
      expect.objectContaining({ state: 'resolved', reason: 'delivery', factId: answer.itemId })
    )
  )
  expect(journal.snapshot().items).toEqual([])
})
