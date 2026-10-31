import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import Database from '../../sqlite/sync-database'
import {
  agentJournalItemKey,
  parseAgentJournalItemKey
} from '../../../shared/agent-session-journal-item-key'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { agentSessionSendBodyFingerprint } from '../../../shared/structured-agent-session-send-mutation'
import { createTrackedJournalOpener } from './journal-host-database-test-support'
import { journalDatabasePath } from './journal-host-database'
import { replayJournal, startJournalRowFold } from './journal-open'
import { JournalStoppedTurns } from './journal-stopped-turns'
import { createDeferredStructuredAgentSessionEventSink } from '../agent-session-wire/structured-agent-session-event-sink'
import { testEventSinkLogging } from '../agent-session-wire/structured-agent-session-logger-test-support'
import { createCodexJournalTranslator } from '../../codex/codex-structured-journal-translation'
import {
  codexTurnLifecycleIdentity,
  publishCodexTurnLifecycle
} from '../../codex/codex-structured-journal-translation-turns'
import {
  resolveAgentJournalTurnRowWrite,
  writeAgentJournalTurnRow
} from '../agent-session-timeline/agent-journal-turn-row-revision'
import {
  readAgentSessionHistory,
  createAgentSessionCatchUpReader
} from '../agent-session-wire/agent-session-history-page'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import { mergeItems } from '../../../shared/structured-agent-session-history-state'
import type {
  AgentJournalMessageItem,
  AgentJournalTurnItem
} from '../../../shared/agent-session-journal-types'
import type { AgentSessionJournal } from './journal-store'

const SESSION = 'normalization'
const THREAD = 'thread'
const journals = createTrackedJournalOpener({ scoped: true })
const directories: string[] = []
const receipt = { write: () => {}, committed: () => {} }
const identity = {
  sessionId: SESSION,
  workspaceId: 'folder',
  hostId: 'local',
  agent: 'codex' as const,
  providerHandle: codexProviderHandle(THREAD)
}
const target = (turnId = 'T') => codexTurnLifecycleIdentity(SESSION, turnId)
const failed = (turnId = 'T'): AgentJournalTurnItem => ({
  kind: 'turn',
  turnId,
  state: 'completed',
  outcome: 'failure',
  startedAt: 1_000,
  completedAt: 4_000,
  durationMs: 3_000
})
const message = (text: string): AgentJournalMessageItem => ({
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text }]
})
async function open() {
  const root = journals.ownRoot(await mkdtemp(join(tmpdir(), 'orca-stop-normalization-')))
  directories.push(root)
  return {
    root,
    journal: await journals.open({ identity, stateDirectory: root, now: () => 5_000 })
  }
}
function retained(journal: AgentSessionJournal) {
  return journal.snapshot().items.map((item) => {
    const identity = parseAgentJournalItemKey(item.itemId)
    if (!identity) {
      throw new Error('missing retained identity')
    }
    return {
      identity,
      body: item.body,
      observedAt: item.observedAt,
      ownerFence: 1,
      ...(item.turnScope ? { turnScope: item.turnScope } : {})
    }
  })
}
async function accepted(journal: AgentSessionJournal, clientMessageId = 'input') {
  const body = message(clientMessageId)
  await journal.appendSubmission({
    clientMessageId,
    payloadFingerprint: agentSessionSendBodyFingerprint(SESSION, body),
    body,
    fence: 1,
    handoverRecorded: true
  })
  await journal.resolveDispatch({
    clientMessageId,
    state: 'accepted',
    fence: 1,
    providerIdentity: { provider: 'codex', threadId: THREAD, turnId: clientMessageId, ordinal: 0 }
  })
}
afterEach(async () => {
  vi.restoreAllMocks()
  directories.splice(0)
  await journals.dispose()
})

it.each([false, true])(
  'materializes ordinary failure versus retry-only withdrawal=%s without replaying Stop as a new action',
  async (retryOnly) => {
    const { root, journal } = await open()
    await accepted(journal)
    const key = agentJournalItemKey(target())
    if (!retryOnly) {
      await journal.appendItem(
        target(),
        { ...failed(), state: 'running', outcome: undefined },
        { fence: 1, turnScope: { kind: 'thread' } }
      )
      await journal.appendStopEvent({ reason: 'user-stop', turnId: 'T', caller: 'desktop' }, 1)
    }
    await journal.appendItem(target(), failed(), { fence: 1, turnScope: { kind: 'thread' } })
    const beforeStop = journal.cursor()
    if (retryOnly) {
      await journal.appendStopEvent({ reason: 'user-stop', turnId: 'T', caller: 'desktop' }, 1)
    }
    const before = journal.item(key)!
    const pageCursor = await journal.appendQueueReopen(1)
    for (const direction of ['tail', 'before'] as const) {
      const result = readAgentSessionHistory(journal, {
        sessionId: SESSION,
        direction,
        cursor: pageCursor,
        limit: 2
      })
      // Tail and backwards reads publish the same effective existing item.
      expect(result.ok).toBe(true)
      if (!result.ok) {
        throw new Error(result.reset)
      }
      expect(
        readAgentJournalTurn(result.page.items.find((item) => item.itemId === key)?.body)?.outcome
      ).toBe(retryOnly ? 'cancellation' : 'failure')
    }
    if (retryOnly) {
      const caught = createAgentSessionCatchUpReader(journal)({
        sessionId: SESSION,
        direction: 'after',
        cursor: beforeStop,
        limit: 2
      })
      expect(caught.ok).toBe(true)
      if (!caught.ok) {
        throw new Error(caught.reset)
      }
      expect(
        readAgentJournalTurn(caught.page.items.find((item) => item.itemId === key)?.body)?.outcome
      ).toBe('cancellation')
      expect(
        mergeItems(
          [{ ...before, body: failed() }],
          caught.page.items,
          caught.page.removedItemIds
        ).find((item) => item.itemId === key)?.body
      ).toMatchObject({ outcome: 'cancellation' })
    }
    const original = journal.queuedMessages.userStopInForce()!
    const card = await journal.queuedMessages.insert({
      messageId: 'after-S',
      body: message('after Stop')
    })
    for (let repeat = 0; repeat < 3; repeat++) {
      await journal.replaceEpochItems('handle_forked', 1, retained(journal))
      expect(journal.itemBody(key)).toEqual(before.body)
      expect(journal.item(key)?.observedAt).toBe(before.observedAt)
      expect(journal.queuedMessages.userStopInForce()?.event).toEqual(
        retryOnly
          ? { reason: 'user-stop', at: original.event.at, caller: 'desktop' }
          : original.event
      )
      expect(journal['state'].hasAppliedProviderAcceptance).toBe(false)
      expect(journal['state'].stoppedTurns['stopped'].size).toBe(0)
      expect(journal.queuedMessages.get(card.messageId)).toMatchObject({ state: 'waiting' })
      const reopened = await journals.open({ identity, stateDirectory: root })
      expect(reopened.itemBody(key)).toEqual(before.body)
      const readOnly = new Database(journalDatabasePath(root), {
        readonly: true,
        fileMustExist: true
      })
      try {
        const loaded = replayJournal(readOnly, SESSION)!
        expect(loaded.damage).toBeNull()
        expect(loaded.state.items.get(key)?.body).toEqual(before.body)
        expect(loaded.state.hasAppliedProviderAcceptance).toBe(false)
      } finally {
        readOnly.close()
      }
    }
    // This very epoch admits fresh operational input; the carried ordinary marker is never revisited.
    await accepted(journal, 'new-root')
    await journal.appendItem(target('new-root'), failed('new-root'), {
      fence: 1,
      turnScope: { kind: 'thread' }
    })
    await journal.appendStopEvent({ reason: 'user-stop', turnId: 'new-root' }, 1)
    expect(journal.itemBody(agentJournalItemKey(target('new-root')))).toMatchObject({
      outcome: 'cancellation'
    })
    expect(journal.itemBody(key)).toEqual(before.body)
  }
)

it.each([false, true])(
  'keeps original retry-only action identity through real context rewind with target retained=%s',
  async (keep) => {
    const { root, journal } = await open()
    await journal.context.clear({ operationId: 'clear', afterFence: 1, clearedAt: 500 }, receipt)
    const floor = journal.context.floor()!
    await accepted(journal)
    await journal.appendItem(target(), failed(), { fence: 1, turnScope: { kind: 'thread' } })
    await journal.appendStopEvent({ reason: 'user-stop', turnId: 'T' }, 1)
    const mark = journal.queuedMessages.userStopInForce()!
    const effective = retained(journal).filter((item) => item.body.kind === 'turn')
    await journal.context.rewind(floor, 1, keep ? effective : [], () => receipt)
    expect(journal.stoppedTurnItemId('T')).toBeUndefined()
    expect(journal.stopNamesCancelledTurn('T', mark.sequence)).toBe(true)
    expect(journal['state'].stoppedTurns['roots'].size).toBe(keep ? 1 : 0)
    expect(journal['state'].stoppedTurns['stopped'].size).toBe(0)
    const reopened = await journals.open({ identity, stateDirectory: root })
    expect(reopened.stopNamesCancelledTurn('T', mark.sequence)).toBe(true)
    expect(reopened.snapshot()).toEqual(journal.snapshot())
    await journal.appendQueueResume(1)
    expect(journal.stopNamesCancelledTurn('T', mark.sequence)).toBe(false)
    await journal.replaceEpochItems('handle_forked', 1, retained(journal))
    expect(journal.queuedMessages.userStopInForce()).toBeNull()
  }
)

it.each(['none', 'replacement', 'context-rewind'] as const)(
  'actual settled Codex request attribution preserves effective lifecycle after %s, but genuine lifecycle still owns its outcome',
  async (normalization) => {
    const { journal } = await open()
    await journal.context.clear({ operationId: 'clear', afterFence: 1, clearedAt: 500 }, receipt)
    const floor = journal.context.floor()!
    await accepted(journal)
    const deferred = createDeferredStructuredAgentSessionEventSink(testEventSinkLogging(SESSION))
    deferred.bind({ journal, fence: 1, publish: () => {} })
    const translator = createCodexJournalTranslator({
      sink: deferred.sink,
      primaryThreadId: () => THREAD,
      now: () => 2_000,
      dispatchRequestOrigin: (id) => ({
        requestedAt: id === 'earlier' ? 600 : 800,
        sequence: id === 'earlier' ? 1 : 2
      })
    })
    const notify = (method: string, params: unknown) =>
      translator.handle({
        type: 'notification',
        sessionId: SESSION,
        threadId: THREAD,
        method,
        params
      })
    try {
      notify('turn/started', { turn: { id: 'T' } })
      notify('turn/completed', { turn: { id: 'T', status: 'failed' } })
      await deferred.drained()
      await journal.appendStopEvent({ reason: 'user-stop', turnId: 'T' }, 1)
      if (normalization === 'replacement') {
        await journal.replaceEpochItems('handle_forked', 1, retained(journal))
      }
      if (normalization === 'context-rewind') {
        await journal.context.rewind(
          floor,
          1,
          retained(journal).filter((item) => item.body.kind === 'turn'),
          () => receipt
        )
      }
      const key = agentJournalItemKey(target())
      const before = journal.item(key)!
      writeAgentJournalTurnRow(
        deferred.sink,
        { identity: target() },
        { contextUsage: { window: { tokens: 32_000, capturedAt: 2_000 } } },
        { publish: true }
      )
      await deferred.drained()
      expect(journal.itemBody(key)).toMatchObject({
        outcome: 'cancellation',
        contextUsage: { window: { tokens: 32_000 } }
      })
      notify('item/completed', {
        turnId: 'T',
        item: { type: 'userMessage', id: 'late-request', clientId: 'later', content: [] }
      })
      await deferred.drained()
      expect(journal.itemBody(key)).toMatchObject({
        state: 'interrupted',
        outcome: 'cancellation',
        requestedAt: 800
      })
      expect(journal.itemBody(key)).toMatchObject({ startedAt: 2_000, completedAt: 2_000 })
      expect(journal.item(key)?.observedAt).toBe(before.observedAt)
      expect(mergeItems([before], [journal.item(key)!], []).at(0)?.body).toMatchObject({
        outcome: 'cancellation'
      })
      publishCodexTurnLifecycle({
        sink: deferred.sink,
        primaryThreadId: THREAD,
        sessionId: SESSION,
        threadId: THREAD,
        turnId: 'T',
        state: 'completed',
        outcome: 'success',
        completedAt: 9_000
      })
      await deferred.drained()
      notify('item/completed', {
        turnId: 'T',
        item: { type: 'userMessage', id: 'earlier-request', clientId: 'earlier', content: [] }
      })
      await deferred.drained()
      expect(journal.itemBody(key)).toMatchObject({
        outcome: 'success',
        completedAt: 9_000,
        requestedAt: 600
      })
      expect(journal.itemBody(key)).not.toHaveProperty('startedAt')
      expect(journal.stoppedTurnItemId('T')).toBeUndefined()
    } finally {
      translator.dispose()
      await deferred.drained()
    }
  }
)

it('preserves attribution-owned versus lifecycle-owned fields in oversized, absent-row and nonreading fallbacks', () => {
  const lifecycle = failed()
  const current = Object.assign(
    {
      ...lifecycle,
      state: 'interrupted' as const,
      outcome: 'cancellation' as const,
      completedAt: 7_000,
      providerTurnId: 'provider-owned'
    },
    { futureExtension: 'x'.repeat(20_000) }
  )
  const journal = { itemBody: () => current, visitItems: () => {} }
  const write = {
    lifecycle: { ...lifecycle, userItemId: 'exact-opener', requestedAt: 800 },
    attributionOnly: true as const
  }
  const revised = resolveAgentJournalTurnRowWrite(journal, { identity: target() }, write, 1_024)!
  expect(revised.body).toMatchObject({
    state: 'interrupted',
    outcome: 'cancellation',
    completedAt: 7_000,
    startedAt: 1_000,
    requestedAt: 800,
    userItemId: 'exact-opener',
    providerTurnId: 'provider-owned'
  })
  expect(revised.body).not.toHaveProperty('futureExtension')
  expect(
    resolveAgentJournalTurnRowWrite(
      { ...journal, itemBody: () => null },
      { identity: target() },
      write,
      1_024
    )?.body
  ).toEqual(write.lifecycle)
  const bodies: unknown[] = []
  writeAgentJournalTurnRow(
    { appendItem: (_id, body) => bodies.push(body), appendTombstone: () => {}, publish: () => {} },
    { identity: target() },
    write,
    { publish: true }
  )
  expect(bodies).toEqual([write.lifecycle])
  expect(
    resolveAgentJournalTurnRowWrite(journal, { identity: target() }, { lifecycle }, 1_024)?.body
  ).toEqual(lifecycle)
})

it('does not leak acceptance or Stop derivation across replacement rollback, and adopts before a fallible postcommit receipt', async () => {
  const { root, journal } = await open()
  await accepted(journal)
  await journal.appendItem(target(), failed(), { fence: 1, turnScope: { kind: 'thread' } })
  await journal.appendStopEvent({ reason: 'user-stop', turnId: 'T' }, 1)
  const before = journal.snapshot()
  const mark = journal.queuedMessages.userStopInForce()!
  const db = journals.database(root).db
  db.exec(`CREATE TEMP TRIGGER reject_normalization BEFORE INSERT ON journal_rows
    WHEN NEW.session_id = 'normalization' AND instr(NEW.row_json, 'handle_forked') > 0
    BEGIN SELECT RAISE(ABORT, 'normalization disk failure'); END`)
  try {
    await expect(journal.replaceEpochItems('handle_forked', 1, retained(journal))).rejects.toThrow(
      'normalization disk failure'
    )
    expect(journal.snapshot()).toEqual(before)
    expect(journal.stopNamesCancelledTurn('T', mark.sequence)).toBe(true)
  } finally {
    db.exec('DROP TRIGGER reject_normalization')
  }
  await expect(
    journal.replaceEpochItems('handle_forked', 1, retained(journal), () => ({
      write: () => {},
      committed: () => {
        throw new Error('receipt callback failed after adoption')
      }
    }))
  ).rejects.toThrow('receipt callback failed after adoption')
  expect(journal.epoch).not.toBe(before.cursor.epoch)
  expect(journal.itemBody(agentJournalItemKey(target()))).toMatchObject({ outcome: 'cancellation' })
  expect(journal['state'].hasAppliedProviderAcceptance).toBe(false)
  expect(journal.queuedMessages.userStopInForce()?.event).not.toHaveProperty('turnId')
  expect((await journals.open({ identity, stateDirectory: root })).snapshot()).toEqual(
    journal.snapshot()
  )
})

it.each([100, 1_000])(
  'bounds the actual replacement/context-rewind/replay derivation for %i roots without historical Stop searches',
  async (population) => {
    const { root, journal } = await open()
    const observe = vi.spyOn(JournalStoppedTurns.prototype, 'observe')
    const accept = vi.spyOn(JournalStoppedTurns.prototype, 'accept')
    await journal.context.clear({ operationId: 'clear', afterFence: 1, clearedAt: 500 }, receipt)
    const floor = journal.context.floor()!
    await accepted(journal)
    for (let index = 0; index < population; index++) {
      await journal.appendItem(target(`T-${index}`), failed(`T-${index}`), {
        fence: 1,
        turnScope: { kind: 'thread' }
      })
    }
    await journal.appendStopEvent({ reason: 'user-stop', turnId: 'T-0' }, 1)
    const mark = journal.queuedMessages.userStopInForce()!
    const keys = retained(journal).filter((item) => item.body.kind === 'turn')
    observe.mockClear()
    accept.mockClear()
    await journal.context.rewind(floor, 1, keys, () => receipt)
    expect(observe).toHaveBeenCalledTimes(population)
    expect(accept).toHaveBeenCalledTimes(1) // existing clear restatement, never replayed S
    expect(journal.stopNamesCancelledTurn('T-0', mark.sequence)).toBe(true)
    for (let repeat = 0; repeat < 3; repeat++) {
      observe.mockClear()
      accept.mockClear()
      await journal.replaceEpochItems('handle_forked', 1, retained(journal))
      expect(observe.mock.calls.length).toBe(population + 1) // roots plus original clear item
      expect(accept.mock.calls.length).toBeLessThanOrEqual(4)
      expect(journal['state'].stoppedTurns['roots'].size).toBe(population)
      expect(journal['state'].stoppedTurns['stopped'].size).toBe(0)
      const rows = journals
        .database(root)
        .db.prepare(
          'SELECT seq, row_json AS rowJson FROM journal_rows WHERE session_id = ? AND epoch = ? ORDER BY seq'
        )
        .all(SESSION, journal.cursor().epoch)
      observe.mockClear()
      accept.mockClear()
      const fold = startJournalRowFold({ sessionId: SESSION, epoch: journal.cursor().epoch })
      for (const row of rows) {
        if (typeof row.seq !== 'number' || typeof row.rowJson !== 'string') {
          throw new Error('invalid test row')
        }
        fold.add({ seq: row.seq, rowJson: row.rowJson })
      }
      expect(fold.finish().state.items.size).toBe(population + 1)
      expect(observe).toHaveBeenCalledTimes(population + 1)
      expect(accept.mock.calls.length).toBeLessThanOrEqual(4)
      expect(rows.length).toBeLessThanOrEqual(population + 6)
    }
  },
  60_000
)
