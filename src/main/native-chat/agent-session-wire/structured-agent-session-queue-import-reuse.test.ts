import { JournalWriteProjection } from '../agent-session-journal/journal-write-projection'
import { encodeJournalState } from '../agent-session-journal/journal-state-codec'
import { journalOutcomeSource } from '../agent-session-journal/journal-outcome-format'
import { LegacyQueuedCards } from '../agent-session-journal/journal-queue-import'
import { openRigTurnFor } from './structured-agent-session-queued-rig-turn.test-fixture'
import { loadTestJournal } from '../agent-session-journal/journal-host-database-test-support'
import { expect, it, vi } from 'vitest'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import type { AgentSessionSubscribeEvent } from '../../../shared/agent-session-wire'
import { AgentSessionSubscribers } from './structured-agent-session-subscribers'
import { createAgentSessionCatchUpReader } from './agent-session-history-page'
import {
  HOST_TEST_SESSION as SESSION,
  hostTestOperationId
} from './structured-agent-session-host-test-data'
import {
  eventually,
  QUEUED_RIG_CALLER as CALLER
} from './structured-agent-session-queued-message-rig.test-fixture'

import {
  fixture,
  type Legacy,
  db,
  handOff,
  journalFor,
  legacyIds,
  message,
  nothingSentTo,
  seedLegacy,
  threadWrite
} from './structured-agent-session-queue-import-contract-test-fixture'

it.each([100, 1_000])('raw selection reuse: %i waiting cards', async (size) => {
  const journal = journalFor(SESSION)
  const rows = Array.from({ length: size }, (_, i): Legacy => [`waiting-${i}`, 'waiting', 'words'])
  seedLegacy(SESSION, rows)
  db().exec(`CREATE TEMP TRIGGER b2_raw_fail_import BEFORE DELETE ON queued_messages
    BEGIN SELECT RAISE(ABORT, 'disk full'); END`)
  await journal.open()
  expect(legacyIds()).toHaveLength(size)
  const feed = new AgentSessionSubscribers()
  const base = { sessionId: SESSION, journal, fence: 0, cursor: journal.cursor() }
  const received: AgentSessionSubscribeEvent[][] = [[], [], []]
  received.forEach((events, index) =>
    feed.open({
      ...base,
      id: String(index),
      boundedFrames: index === 1,
      snapshotCatchUp: index !== 2,
      readsCurrentRequests: index !== 2,
      emit: (event) => events.push(event)
    })
  )
  let visits = 0
  const flatMap = Array.prototype.flatMap
  const scans = vi.spyOn(Array.prototype, 'flatMap')
  scans.mockImplementation(function (this: { messageId?: string }[], callback, thisArg) {
    const legacy = this.length === size && this[0]?.messageId === 'waiting-0'
    return flatMap.call(this, (...args) => {
      visits += legacy ? 1 : 0
      return callback.apply(thisArg, args)
    })
  })
  try {
    const turn = { provider: 'codex' as const, threadId: 'progress', turnId: 't', ordinal: 0 }
    await journal.appendItem(turn, message('progress'), threadWrite)
    feed.publish(SESSION, journal)
    // Provider progress cannot change a legacy card’s exact handoff classification.
    expect(visits).toBe(0)
    expect(journal.publicRead().normalizationKey).toBe('')
    expect(journal.queuedMessages.list().filter((c) => c.state === 'waiting')).toHaveLength(size)
    for (const events of received) {
      const items = events.flatMap((e) => (e.type === 'batch' ? e.batch.items : []))
      expect(items.map((i) => i.body)).toContainEqual(message('progress'))
      expect(events.filter((e) => e.type === 'snapshot')).toHaveLength(0)
    }
    visits = 0
    for (let p = 0; p < 5; p++) {
      feed.publish(SESSION, journal)
    }
    expect(visits).toBe(0)
    const answered = { turn: { ...turn, ordinal: -1 }, via: 'steer' as const }
    await handOff(journal, 'u', 'waiting-0', 'words', 'cancelled', 0, undefined, answered)
    feed.publish(SESSION, journal)
    const view = journal.publicRead()
    expect(view.normalizationKey).not.toBe('')
    expect(view.snapshot.submissions.find((s) => s.clientMessageId === 'u')).toMatchObject({
      dispatchState: 'unknown',
      queuedMessageId: 'waiting-0'
    })
    const item = view.snapshot.items.find((i) => i.itemId === agentJournalSubmissionKey('u'))
    expect(item?.body).toEqual(message('words'))
    expect(item?.sequence).toBeLessThan(journal.cursor().sequence)
    expect(journal.submission('u')?.dispatchState).toBe('rejected')
    expect(visits).toBeGreaterThanOrEqual(2 * size)
    visits = 0
    for (let p = 0; p < 5; p++) {
      feed.publish(SESSION, journal)
    }
    expect(visits).toBe(0)
    expect(received.map((es) => es.filter((e) => e.type === 'snapshot').length)).toEqual([1, 1, 0])
  } finally {
    scans.mockRestore()
    db().exec('DROP TRIGGER b2_raw_fail_import')
    await journal.close()
  }
})

it('public metadata follows legacy-only commits, item recreation and epoch replacement', async () => {
  const earlier = journalFor(SESSION)
  await earlier.open()
  await earlier.queuedMessages.insert({ messageId: 'q', body: message('words') })
  await handOff(earlier, 'u', 'q', 'words', 'cancelled')
  await earlier.close()
  seedLegacy(SESSION, [['gone', 'withdrawn', 'deleted']])
  db().exec(`CREATE TEMP TRIGGER b2_source_fail_import BEFORE DELETE ON queued_messages
    BEGIN SELECT RAISE(ABORT, 'disk full'); END`)
  const journal = journalFor(SESSION)
  await journal.open()
  const ids = vi.spyOn(journal.queuedMessages.displayState().normalizedHandOffs, Symbol.iterator)
  const key = journal.publicRead().normalizationKey
  const snapshot = journal.snapshot()
  expect(journal.snapshot()).toBe(snapshot)
  expect(key).not.toBe('')
  const cursor = journal.cursor()
  const catchUp = createAgentSessionCatchUpReader(journal, undefined, journal.publicRead())
  const request = { sessionId: SESSION, direction: 'tail' as const }
  const beforeImport = catchUp(request)
  expect(beforeImport).toMatchObject({ ok: true, page: { items: snapshot.items } })
  db().exec('DROP TRIGGER b2_source_fail_import')
  await journal.queuedMessages.importAtOpen()
  expect(journal.cursor()).toEqual(cursor)
  expect(legacyIds()).toEqual([])
  expect(journal.snapshot()).not.toBe(snapshot)
  expect(catchUp(request)).toEqual(beforeImport)
  expect(ids).toHaveBeenCalledTimes(1)
  expect(journal.publicRead().normalizationKey).toBe(key)
  expect(ids).toHaveBeenCalledTimes(2)
  ids.mockRestore()
  const identity = { provider: 'orca' as const, clientMessageId: 'u' }
  await journal.appendTombstone(identity, { fence: 0 })
  expect(journal.publicRead().normalizationKey).toBe('')
  expect(journal.snapshot().items).toEqual([])
  await journal.appendItem(identity, message('recreated'), threadWrite)
  expect([key, '']).not.toContain(journal.publicRead().normalizationKey)
  expect(journal.snapshot().items[0]?.body).toEqual(message('recreated'))
  await journal.rollEpoch('handle_forked', 0)
  expect(journal.epoch).not.toBe(cursor.epoch)
  expect(journal.publicRead().normalizationKey).toBe('')
  expect(journal.snapshot().items).toEqual([])
  await journal.close()
})

it('a rewind while the import has failed moves the legacy cards first: a refused one stays returned', async () => {
  const earlier = journalFor(SESSION)
  const clear = { command: 'clear' as const }
  expect(
    await fixture.rig.host.conversationCommand(CALLER, {
      ...clear,
      envelope: fixture.rig.envelope(
        clear,
        'agentSession.conversationCommand',
        hostTestOperationId()
      )
    })
  ).toMatchObject({ ok: true })
  const target = fixture.rig.send('rewound away')
  expect(await target.result).toMatchObject({ ok: true })
  await eventually(async () =>
    expect((await fixture.rig.submission(target.id))?.handedOverAt).toBeDefined()
  )
  await fixture.rig.settleAccepted(target.id, 'target')
  await fixture.rig.host.close(SESSION, 'evict')
  await earlier.open()
  const fence = fixture.rig.store.getRecord(SESSION)!.lease.runtimeFence
  await handOff(
    earlier,
    'att-refused',
    'disp-refused',
    'refused, never settled',
    'providerRejected',
    fence
  )
  await earlier.close()
  seedLegacy(SESSION, [
    ['disp-refused', 'dispatched', 'refused, never settled', 'att-refused'],
    ['edited', 'waiting', 'waiting, edited']
  ])
  db().exec(`CREATE TEMP TRIGGER fail_import BEFORE DELETE ON queued_messages
    BEGIN SELECT RAISE(ABORT, 'disk full'); END`)
  const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  const held = [
    { messageId: 'disp-refused', state: 'returned' },
    { messageId: 'edited', state: 'waiting' }
  ]
  expect(await fixture.rig.drafts()).toEqual(held)
  db().exec('DROP TRIGGER fail_import')
  warned.mockRestore()

  const live = fixture.rig.host.collaboratorsForTests().sessions.get(SESSION)!.journal
  const rewound = { itemId: agentJournalSubmissionKey(target.id), expectedEpoch: live.epoch }
  expect(
    await fixture.rig.host.rewind(CALLER, {
      ...rewound,
      envelope: fixture.rig.envelope(rewound, 'agentSession.rewind', hostTestOperationId())
    })
  ).toMatchObject({ ok: true })
  expect(live.epoch).toBe(rewound.expectedEpoch)
  expect(live.submission('att-refused')).toBeUndefined()
  expect(await fixture.rig.drafts()).toEqual(held)
  await nothingSentTo('edited')
  expect(legacyIds()).toEqual([])
})

it.each([
  { importNext: false, format1: false },
  { importNext: true, format1: false },
  { importNext: false, format1: true }
])(
  'persists fallback identity through recovery (next import=$importNext, format1=$format1)',
  async ({ importNext, format1 }) => {
    const rig = fixture.rig
    await rig.host.close(SESSION, 'evict')
    const seed = journalFor(SESSION)
    await seed.open()
    await seed.queuedMessages.insert({ messageId: 'C', body: message('/compact') })
    await seed.close()
    if (format1) {
      db().exec(
        "DELETE FROM journal_outcomes WHERE field IN ('inputEntries','inputCards'); UPDATE journal_outcomes SET format=1; UPDATE journal_outcome_epochs SET format=1"
      )
    }
    seedLegacy(SESSION, [['D', 'waiting', 'original D']])
    db().prepare('UPDATE queued_messages SET position = 2 WHERE message_id = ?').run('D')
    db().exec(`CREATE TEMP TRIGGER overlay_import_failure BEFORE DELETE ON queued_messages
    BEGIN SELECT RAISE(ABORT, 'import failure'); END`)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const importAtOpen = LegacyQueuedCards.prototype.importAtOpen
    const fault = vi
      .spyOn(LegacyQueuedCards.prototype, 'importAtOpen')
      .mockImplementation(function (this: LegacyQueuedCards) {
        return importAtOpen
          .call(this)
          .finally(() => db().exec('DROP TRIGGER IF EXISTS overlay_import_failure'))
      })
    try {
      const w = await rig.workingSend()
      await openRigTurnFor(rig, w)
      await rig.settleAccepted(w, 'W')
      const live = rig.host.collaboratorsForTests().sessions.get(SESSION)!.journal
      expect(journalOutcomeSource(db(), SESSION, live.epoch)?.format).toBe(2)
      expect(live.queuedMessages.get('C')?.state).toBe('waiting')
      expect(legacyIds()).toEqual(['D'])
      live.publicRead()
      const m = rig.send('original M', undefined, { carried: { effort: 'high' } })
      const result = await m.result
      expect(result).toMatchObject({ ok: true, value: { submission: { clientMessageId: m.id } } })
      const receipt = rig.store.readCommandReceipt({ kind: 'global' }, m.id)
      expect(live.inputOrder.forced(m.id)).toBe(true)
      expect(live.submission(m.id)?.handedOverAt).toBeUndefined()
      expect(live.inputOrder.precedes(live.queuedMessages.get('D')!, live.submission(m.id)!)).toBe(
        true
      )
      if (!importNext) {
        db().exec(`CREATE TEMP TRIGGER overlay_import_failure BEFORE DELETE ON queued_messages
      BEGIN SELECT RAISE(ABORT, 'import failure'); END`)
      }
      await rig.host.flushAllStreamedEvents()
      rig.crashRestartHostProcess()
      await rig.submission(m.id)
      const reopened = rig.host.collaboratorsForTests().sessions.get(SESSION)!.journal
      const order = reopened.queuedMessages
        .list()
        .filter((c) => c.state === 'waiting')
        .map((c) => c.messageId)
      // Let the complete production iteration expose even the causal wrong C,M,D ordering.
      expect(await rig.resume()).toMatchObject({ ok: true, value: { resumed: true } })
      const delivered: string[] = []
      for (const id of order) {
        if (id === 'C') {
          await eventually(() => expect(rig.compact).toHaveBeenCalledOnce())
          rig.finishCompact()
        } else {
          await eventually(async () => expect((await rig.handoff(id))?.handedOverAt).toBeDefined())
          const h = await rig.handoffId(id)
          const calls = rig.dispatch.mock.calls.filter(([input]) => input.clientMessageId === h)
          expect(calls).toHaveLength(1)
          expect(calls[0]![0].body).toEqual(message(id === 'D' ? 'original D' : 'original M'))
          if (id === m.id) {
            expect(calls[0]![0].executionOptions).toMatchObject({ effort: 'high' })
          }
          await rig.settleAccepted(h, id)
          expect(await rig.submission(h)).toMatchObject({
            dispatchState: 'accepted',
            queuedMessageId: id
          })
        }
        delivered.push(id)
      }
      expect(rig.store.readCommandReceipt({ kind: 'global' }, m.id)).toEqual(receipt)
      expect(reopened.item(agentJournalSubmissionKey(m.id))?.body).toEqual(message('original M'))
      expect(reopened.submission(m.id)?.options).toEqual({ effort: 'high' })
      expect(reopened.queuedMessages.list().filter((c) => c.state === 'waiting')).toEqual([])
      const restored = loadTestJournal(rig.root, SESSION)!
      expect(restored.damage).toBeNull()
      expect(restored.state.inputEntries.size).toBe(0)
      expect(restored.state.inputCards.size).toBe(0)
      expect(reopened['state'].inputCards.size).toBe(0)
      expect(rig.dispatch.mock.calls.filter(([input]) => input.clientMessageId === w)).toHaveLength(
        1
      )
      expect(delivered).toEqual(['C', 'D', m.id])
    } finally {
      db().exec('DROP TRIGGER IF EXISTS overlay_import_failure')
      fault.mockRestore()
      warn.mockRestore()
    }
  }
)

it.each([
  { readFirst: false, legacyCommand: false },
  { readFirst: true, legacyCommand: false },
  { readFirst: false, legacyCommand: true }
])(
  'keeps reads derivative and persists fallback (public=$readFirst, legacyCommand=$legacyCommand)',
  async ({ readFirst, legacyCommand }) => {
    const seed = journalFor('overlay-direct')
    await seed.open()
    if (!legacyCommand) {
      await seed.queuedMessages.insert({ messageId: 'C', body: message('/compact') })
    }
    await seed.close()
    seedLegacy(
      'overlay-direct',
      legacyCommand
        ? [
            ['C', 'waiting', '/compact'],
            ['D', 'waiting', 'D']
          ]
        : [['D', 'waiting', 'D']]
    )
    db().exec(`CREATE TEMP TRIGGER overlay_direct_import_failure BEFORE DELETE ON queued_messages
    BEGIN SELECT RAISE(ABORT, 'import failure'); END`)
    const journal = journalFor('overlay-direct')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await journal.open()
      const state = journal['state']
      const before = encodeJournalState(state)
      if (readFirst) {
        journal.publicRead()
        journal.queuedMessages.nextInputCard()
        expect(encodeJournalState(state)).toEqual(before)
        JournalWriteProjection.verifyEachCommit = true
        await journal.appendItem(
          { provider: 'orca', clientMessageId: 'unrelated' },
          message('unrelated'),
          threadWrite
        )
      }
      const target = await journal.appendSubmission({
        clientMessageId: 'original-M',
        payloadFingerprint: 'original',
        body: message('original M'),
        handoverRecorded: true,
        origin: 'client',
        fence: 0,
        options: { effort: 'high' }
      })
      expect(journal.inputOrder.forced('original-M')).toBe(true)
      expect(
        journal.inputOrder.precedes(
          journal.queuedMessages.get('D')!,
          journal.submission('original-M')!
        )
      ).toBe(true)
      const saved = loadTestJournal(fixture.rig.root, 'overlay-direct')!
      expect(saved.damage).toBeNull()
      expect(saved.state.inputCards.get('D')).toEqual(journal['state'].inputCards.get('D'))
      expect(saved.state.inputCards.has('D')).toBe(true)
      expect(
        db()
          .prepare(
            "SELECT COUNT(*) AS n FROM journal_outcomes WHERE field='inputCards' AND entry_key=? AND deleted=0"
          )
          .get(JSON.stringify('D'))?.n
      ).toBe(1)
      expect(target).toEqual({
        epoch: journal.epoch,
        sequence: journal.submission('original-M')!.acceptedSequence
      })
      const introduction = journal['state'].inputCards.get('D')!.introduced
      db().exec('DROP TRIGGER overlay_direct_import_failure')
      for (let pass = 0; pass < 2; pass++) {
        await journal.replaceEpochItems('unreconcilable_prefix', 0, [])
        const restored = loadTestJournal(fixture.rig.root, 'overlay-direct')!
        expect(restored.damage).toBeNull()
        expect(restored.state.inputCards.get('D')?.introduced).toBe(introduction)
        expect(
          journal.inputOrder.precedes(
            journal.queuedMessages.get('D')!,
            journal.submission('original-M')!
          )
        ).toBe(true)
        expect(restored.state.inputEntries.get('original-M')).toEqual(
          journal['state'].inputEntries.get('original-M')
        )
      }
    } finally {
      JournalWriteProjection.verifyEachCommit = false
      db().exec('DROP TRIGGER IF EXISTS overlay_direct_import_failure')
      warn.mockRestore()
      await journal.close()
    }
  }
)

it('discovers real overlay ownership before pruning a genuinely saved native identity', async () => {
  const session = 'overlay-saved'
  const seed = journalFor(session)
  await seed.open()
  await seed.queuedMessages.insert({ messageId: 'D', body: message('saved D') })
  const saved = seed['state'].inputCards.get('D')
  const native = db()
    .prepare(
      "SELECT value_json FROM journal_outcomes WHERE field='inputCards' AND entry_key=? ORDER BY seq DESC LIMIT 1"
    )
    .get(JSON.stringify('D'))
  expect(native?.value_json).toBe(JSON.stringify(['D', saved]))
  await seed.close()
  // Independent fixture control: retain the writer's genuine native record, with only legacy body ownership.
  db()
    .prepare("DELETE FROM journal_outcomes WHERE field='queue.cards' AND entry_key=?")
    .run(JSON.stringify('D'))
  seedLegacy(session, [['D', 'waiting', 'saved D']])
  const restored = loadTestJournal(fixture.rig.root, session)!
  expect(restored.damage).toBeNull()
  expect(restored.state.queue.cards.has('D')).toBe(false)
  expect(restored.state.inputEntries.size).toBe(0)
  expect(restored.state.inputCards.get('D')).toEqual(saved)
})
