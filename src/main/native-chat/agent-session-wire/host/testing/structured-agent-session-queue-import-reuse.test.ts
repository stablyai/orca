import '../../../agent-session-journal/queued-messages/journal-queue-legacy-change'
import { JournalWriteProjection } from '../../../agent-session-journal/writing/journal-write-projection'
import { encodeJournalState } from '../../../agent-session-journal/outcomes/journal-state-codec'
import '../../../agent-session-journal/outcomes/journal-outcome-format'
import '../../../agent-session-journal/queued-messages/journal-queue-import'
import './structured-agent-session-queued-rig-turn.test-fixture'
import { loadTestJournal } from '../../../agent-session-journal/store-lifecycle/journal-host-database-test-support'
import { expect, it, vi } from 'vitest'
import { agentJournalSubmissionKey } from '../../../../../shared/agent-session/journal/agent-session-journal-item-key'
import '../../publication/subscribers/structured-agent-session-subscribers'
import { createAgentSessionCatchUpReader } from '../../publication/history/agent-session-history-page'
import {
  HOST_TEST_SESSION as SESSION,
  hostTestOperationId
} from './structured-agent-session-host-test-data'
import { QUEUED_RIG_CALLER as CALLER } from './structured-agent-session-queued-message-rig.test-fixture'
import { eventually } from './structured-agent-session-queued-message-rig-provider.test-fixture'

import {
  fixture,
  db,
  handOff,
  journalFor,
  legacyIds,
  message,
  nothingSentTo,
  seedLegacy,
  threadWrite
} from './structured-agent-session-queue-import-contract-test-fixture'

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
  const ids = vi.spyOn(journal.inputOrder, 'inputForItem')
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
  // The refreshed catch-up resolves the one selected original; normalization reuses it.
  expect(ids).toHaveBeenCalledTimes(2)
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
  expect(live.submission('att-refused')).toMatchObject({
    dispatchState: 'rejected',
    queuedMessageId: 'disp-refused'
  })
  expect(live.item(agentJournalSubmissionKey('att-refused'))).toBeNull()
  expect(await fixture.rig.drafts()).toEqual(held)
  await nothingSentTo('edited')
  await live.queuedMessages.importAtOpen()
  expect(legacyIds()).toEqual([])
  expect(await fixture.rig.drafts()).toEqual(held)
  await nothingSentTo('edited')
})

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
