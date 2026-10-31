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
    expect(visits).toBe(2 * size)
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
