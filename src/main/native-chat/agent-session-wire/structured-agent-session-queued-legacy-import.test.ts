import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalAnsweredTurnIdentity,
  type AgentJournalMessageItem
} from '../../../shared/agent-session-journal-types'
import { activeProviderContext } from '../../../shared/agent-session-provider-context'
import { projectStructuredAgentSessionMessages } from '../../../shared/structured-agent-session-message-projection'
import { structuredAgentSessionCommandTurnIdentity } from '../../../shared/structured-agent-session-command-turn-identity'
import { agentSessionSendBodyFingerprint } from '../../../shared/structured-agent-session-send-mutation'
import type { AgentSessionSubscribeEvent } from '../../../shared/agent-session-wire'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  reduceStructuredAgentSession
} from '../../../shared/structured-agent-session-reducer'
import { AgentSessionSubscribers } from './structured-agent-session-subscribers'
import { readAgentSessionHistory } from './agent-session-history-page'
import { subscriberHistoryReader } from './agent-session-bounded-frames'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import { AgentSessionJournal } from '../agent-session-journal/journal-store'
import {
  HOST_TEST_SESSION as SESSION,
  hostTestOperationId
} from './structured-agent-session-host-test-data'
import {
  createQueuedMessageTestRig,
  eventually,
  QUEUED_RIG_CALLER as CALLER,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'

let rig: QueuedMessageTestRig

beforeEach(async () => {
  rig = await createQueuedMessageTestRig({ restartable: true, rewind: async () => ({ ok: true }) })
})

afterEach(() => rig.dispose())

const db = () => openTestJournalHostDatabase(rig.root).db
const message = (text: string): AgentJournalMessageItem => ({
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text }],
  ...(text === '/compact' ? { command: { name: 'compact' } } : {})
})
const threadWrite = { fence: 0, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
const words = (fact: 'providerRejected' | 'cancelled') =>
  agentSessionFailureWords(
    fact === 'providerRejected'
      ? agentSessionFailureFact(fact, { detail: { text: 'refused', audience: 'person' } })
      : agentSessionFailureFact(fact),
    { surface: 'rejection' }
  )

function journalFor(sessionId: string): AgentSessionJournal {
  return new AgentSessionJournal({
    database: openTestJournalHostDatabase(rig.root),
    identity: {
      sessionId,
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: 'codex',
      providerHandle: activeProviderContext(rig.store.getRecord(SESSION)!).head!.handle
    }
  })
}

async function handOff(
  journal: AgentSessionJournal,
  attempt: string,
  card: string,
  text: string,
  as: 'providerRejected' | 'cancelled' | 'accepted',
  fence = 0,
  beforeAnswer?: () => Promise<void>,
  answeredInTurn?: AgentJournalAnsweredTurnIdentity
): Promise<void> {
  const body = message(text)
  const payloadFingerprint = agentSessionSendBodyFingerprint(journal.queuedMessages.sessionId, body)
  await journal.appendSubmission({
    clientMessageId: attempt,
    payloadFingerprint,
    body,
    fence,
    handoverRecorded: true,
    queuedMessageId: card
  })
  await journal.resolveDispatch({
    clientMessageId: attempt,
    state: 'pending',
    fence,
    turnScope: AGENT_JOURNAL_THREAD_SCOPE
  })
  await beforeAnswer?.()
  await journal.resolveDispatch(
    as === 'accepted'
      ? { clientMessageId: attempt, state: 'accepted', providerIdentity: null, fence }
      : { clientMessageId: attempt, state: 'rejected', ...words(as), fence, answeredInTurn }
  )
}

type Legacy = [id: string, state: string, text: string | null, consumedAs?: string, hold?: string]

function seedLegacy(sessionId: string, rows: readonly Legacy[]): void {
  const insert = db().prepare(
    `INSERT INTO queued_messages (session_id, message_id, position, body_json, fingerprint,
       created_at, host_instance, state, hold_reason, returned_reason, consumed_as)
     VALUES (?, ?, ?, ?, ?, 0, 'earlier', ?, ?, ?, ?)`
  )
  rows.forEach(([id, state, text, consumedAs, hold], index) => {
    const body = text === null ? '{' : JSON.stringify(message(text))
    const print = text === null ? '' : agentSessionSendBodyFingerprint(sessionId, message(text))
    const reason = state === 'returned' ? 'refused before' : null
    insert.run(
      sessionId,
      id,
      index + 1,
      body,
      print,
      state,
      hold ?? null,
      reason,
      consumedAs ?? null
    )
  })
}

const legacyIds = (sessionId = SESSION) =>
  db()
    .prepare('SELECT message_id AS id FROM queued_messages WHERE session_id = ? ORDER BY position')
    .all(sessionId)
    .map((row) => (typeof row === 'object' && row !== null && 'id' in row ? row.id : null))

function queueRows(sessionId = SESSION): string[] {
  return db()
    .prepare('SELECT row_json FROM journal_rows WHERE session_id = ? ORDER BY seq')
    .all(sessionId)
    .flatMap((row) => {
      const json = typeof row === 'object' && row !== null && 'row_json' in row ? row.row_json : ''
      const parsed: unknown = JSON.parse(String(json))
      if (typeof parsed !== 'object' || parsed === null || !('kind' in parsed)) {
        return []
      }
      if (parsed.kind !== 'queue' || !('messageId' in parsed) || !('change' in parsed)) {
        return []
      }
      const change = JSON.stringify(parsed.change)
      const op = /"op":"(\w+)"/.exec(change)?.[1]
      return [`${String(parsed.messageId)}:${op}${change.includes('"returned"') ? '+refusal' : ''}`]
    })
}

async function nothingSentTo(...cards: string[]): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 100))
  for (const card of cards) {
    expect(await rig.handoff(card)).toBeUndefined()
  }
}

it("moves an earlier build's cards into the journal, each action its own card, the rest once per open", async () => {
  // Legacy handoffs were journaled while cards lived in a separate table.
  await rig.drafts()
  await rig.host.close(SESSION, 'evict')
  const earlier = journalFor(SESSION)
  await earlier.open()
  await handOff(earlier, 'att-present', 'ret-present', 'returned here', 'providerRejected')
  await handOff(
    earlier,
    'att-refused',
    'disp-refused',
    'refused, never settled',
    'providerRejected'
  )
  // Stopped legacy handoffs returned to waiting even if the provider already received them.
  await handOff(earlier, 'att-stopped', 'stopped-same', 'stopped, unchanged', 'cancelled')
  await handOff(earlier, 'att-edited', 'stopped-edited', 'stopped, then edited', 'cancelled')
  await earlier.close()
  seedLegacy(SESSION, [
    ['ret-present', 'returned', 'returned here, edited', 'att-present'],
    ['ret-gone', 'returned', 'returned in a lost epoch', 'att-gone'],
    ['cmd-gone', 'returned', '/compact', 'att-cmd'],
    ['disp-refused', 'dispatched', 'refused, never settled', 'att-refused'],
    ['stopped-same', 'waiting', 'stopped, unchanged'],
    ['stopped-edited', 'waiting', 'stopped, then edited, changed'],
    ['orphan', 'dispatched', 'its hand-off is gone', 'att-orphan'],
    ['edited', 'waiting', 'waiting, edited'],
    ['held', 'waiting', 'its send failed', undefined, 'send_failed'],
    ['gone', 'withdrawn', 'deleted'],
    ['broken', 'waiting', null]
  ])
  const all = legacyIds()

  // Failed import must leave both storage and the projected card view unchanged.
  db().exec(`CREATE TEMP TRIGGER fail_import BEFORE DELETE ON queued_messages
    BEGIN SELECT RAISE(ABORT, 'disk full'); END`)
  const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  const published = [
    { messageId: 'ret-present', state: 'returned' },
    { messageId: 'ret-gone', state: 'returned' },
    { messageId: 'cmd-gone', state: 'returned' },
    { messageId: 'disp-refused', state: 'returned' },
    { messageId: 'stopped-edited', state: 'waiting', paused: true },
    { messageId: 'edited', state: 'waiting' },
    { messageId: 'held', state: 'waiting', paused: true }
  ]
  expect(await rig.drafts()).toEqual(published)
  const stopped = async () => {
    const { items, submissions } = await rig.host.journalSnapshot(SESSION)
    return projectStructuredAgentSessionMessages(items, [], submissions).find(
      (entry) => entry.id === agentJournalSubmissionKey('att-stopped')
    )
  }
  const live = rig.host.collaboratorsForTests().sessions.get(SESSION)!.journal
  const rawStopped = structuredClone(live.submission('att-stopped'))
  const displayedStopped = await stopped()
  expect(displayedStopped).toMatchObject({
    stoppedBeforeStart: true,
    blocks: [{ type: 'text', text: 'stopped, unchanged' }]
  })
  expect(live.submission('att-stopped')).toEqual(rawStopped)
  await nothingSentTo('stopped-same')
  db().exec('DROP TRIGGER fail_import')
  expect(warned).toHaveBeenCalledWith(
    '[journal-open] queued-message import skipped:',
    expect.objectContaining({ sessionId: SESSION })
  )
  warned.mockRestore()
  expect(legacyIds()).toEqual(all)
  expect(queueRows()).toEqual([])

  const deletion = hostTestOperationId()
  expect(await rig.deleteQueued('ret-present', deletion)).toMatchObject({
    value: { deleted: true }
  })
  const sent = await rig.sendNow('ret-gone')
  expect(sent).toMatchObject({ ok: true, value: { submission: { queuedMessageId: 'ret-gone' } } })
  expect(queueRows()).toEqual([
    'ret-present:queued',
    'ret-present:withdrawn',
    'ret-gone:queued+refusal'
  ])
  expect(legacyIds()).toEqual(all.filter((id) => id !== 'ret-present' && id !== 'ret-gone'))
  await nothingSentTo('edited', 'held')

  // Reopen imports atomically; write refusals only for handoffs absent from this epoch.
  await rig.restartHostProcess()
  expect(await rig.drafts()).toEqual(published.slice(2))
  expect(legacyIds()).toEqual(['broken'])
  expect(queueRows().slice(3)).toEqual([
    'cmd-gone:queued+refusal',
    'disp-refused:queued',
    'stopped-same:queued',
    'stopped-edited:queued',
    'orphan:queued',
    'edited:queued',
    'held:queued'
  ])
  // Unedited stopped cards remain spent on their existing handoff.
  expect(await stopped()).toEqual(displayedStopped)

  // Refused commands become spent once their own turn reports failure.
  const adopted = rig.host.collaboratorsForTests().sessions.get(SESSION)!.journal
  await adopted.appendItem(
    structuredAgentSessionCommandTurnIdentity('att-cmd'),
    { kind: 'status', text: 'Compact failed' },
    {
      fence: rig.store.getRecord(SESSION)!.lease.runtimeFence,
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    }
  )
  expect(await rig.drafts()).toEqual(published.slice(3))
  expect(await rig.deleteQueued('disp-refused')).toMatchObject({ value: { deleted: true } })
  await rig.resume()
  await eventually(async () => expect(await rig.handoff('edited')).toBeDefined())
  await nothingSentTo('held')
  expect((await rig.handoff('stopped-edited'))?.clientMessageId).toBe('att-edited')
  expect(await rig.sendNow('stopped-edited')).toMatchObject({ ok: true })
  const resent = await rig.handoffId('stopped-edited')
  expect(resent).not.toBe('att-edited')
  await rig.settleAccepted(resent, 'resent')

  const rows = queueRows()
  await rig.restartHostProcess()
  await rig.drafts()
  expect(queueRows()).toEqual(rows)
  expect(await stopped()).toEqual(displayedStopped)
  expect(legacyIds()).toEqual(['broken'])
  expect(await rig.deleteQueued('ret-present', deletion)).toMatchObject({
    replayed: true,
    value: { deleted: true }
  })

  // Answered-only legacy rows retire without writing new journal rows.
  const other = journalFor('session-y')
  await other.open()
  await handOff(other, 'y-att', 'y-sent', 'delivered', 'accepted')
  await other.close()
  seedLegacy('session-y', [
    ['y-gone', 'withdrawn', 'deleted'],
    ['y-sent', 'dispatched', 'delivered', 'y-att']
  ])
  const reopened = journalFor('session-y')
  await reopened.open()
  expect(legacyIds('session-y')).toEqual([])
  expect(queueRows('session-y')).toEqual([])
  expect(reopened.queuedMessages.list()).toEqual([])
  await reopened.close()
})

it.each([100, 1_000].flatMap((size) => [false, true].map((adopt) => ({ size, adopt }))))(
  'publication reuse: $size historical items, adopted=$adopt',
  async ({ size, adopt }) => {
    const corrections = size / 10
    const earlier = journalFor(SESSION)
    await earlier.open()
    await handOff(earlier, 'u-0', 'q-0', 'stopped words', 'cancelled', 0, async () => {
      for (let ordinal = 0; ordinal < size; ordinal++) {
        await earlier.appendItem(
          { provider: 'codex', threadId: 'history', turnId: 't', ordinal },
          { ...message('old answer'), role: 'assistant' },
          { fence: 0, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
        )
      }
    })
    for (let index = 1; index < corrections; index++) {
      await handOff(earlier, `u-${index}`, `q-${index}`, 'stopped words', 'cancelled')
    }
    await earlier.close()
    seedLegacy(
      SESSION,
      Array.from({ length: corrections }, (_, i): Legacy => [`q-${i}`, 'waiting', 'stopped words'])
    )
    if (!adopt) {
      db().exec(`CREATE TEMP TRIGGER b2_perf_fail_import BEFORE DELETE ON queued_messages
      BEGIN SELECT RAISE(ABORT, 'disk full'); END`)
    }
    const journal = journalFor(SESSION)
    await journal.open()
    expect(legacyIds()).toHaveLength(adopt ? 0 : corrections)
    const display = journal.queuedMessages.displayState()
    const feed = new AgentSessionSubscribers()
    const events: AgentSessionSubscribeEvent[] = []
    let visits = 0
    let keyVisits = 0
    function counted<T>(iterator: MapIterator<T>, correction = false): MapIterator<T> {
      const next = iterator.next.bind(iterator)
      iterator.next = (...args) => {
        const result = next(...args)
        if (!result.done) {
          if (correction) {
            keyVisits++
          } else {
            visits++
          }
        }
        return result
      }
      return iterator
    }
    const values = Map.prototype.values
    const entries = Map.prototype[Symbol.iterator]
    const valuesRead = vi.spyOn(Map.prototype, 'values').mockImplementation(function (
      this: Map<unknown, unknown>
    ) {
      return counted(values.call(this))
    })
    const entriesRead = vi.spyOn(Map.prototype, Symbol.iterator).mockImplementation(function (
      this: Map<unknown, unknown>
    ) {
      return counted(entries.call(this))
    })
    const setIterator = Set.prototype[Symbol.iterator]
    const sets = vi.spyOn(Set.prototype, Symbol.iterator).mockImplementation(function (
      this: Set<unknown>
    ) {
      return this.has('u-0') ? counted(setIterator.call(this), true) : setIterator.call(this)
    })
    const gets = vi.spyOn(Map.prototype, 'get')
    const sourceGets = () =>
      gets.mock.contexts.filter((m) => m === display.items || m === display.submissions)
    const sorts = vi.spyOn(Array.prototype, 'sort')
    const json = vi.spyOn(JSON, 'stringify')
    const work = () => [
      keyVisits,
      sorts.mock.contexts.filter((v) => Array.isArray(v) && v[0] === 'u-0').length,
      json.mock.calls.filter(
        ([v]) => Array.isArray(v) && Array.isArray(v[1]) && v[1][0]?.[0] === 'u-0'
      ).length
    ]
    const reset = () => {
      keyVisits = 0
      gets.mockClear()
      sorts.mockClear()
      json.mockClear()
    }
    try {
      for (const id of ['perf-a', 'perf-b', 'old']) {
        feed.open({
          sessionId: SESSION,
          journal,
          fence: 0,
          id,
          boundedFrames: id === 'perf-b',
          cursor: journal.cursor(),
          snapshotCatchUp: id !== 'old',
          readsCurrentRequests: id !== 'old',
          emit: (event) => events.push(event)
        })
      }
      expect(work()).toEqual([corrections, 1, 1])
      expect(sourceGets()).toHaveLength(2 * corrections)
      expect(visits).toBeGreaterThanOrEqual(size)
      const key = journal.publicRead().normalizationKey
      reset()
      visits = 0
      for (let publication = 0; publication < 5; publication++) {
        feed.publish(SESSION, journal)
      }
      // Only subscriber visits; history copies/materialization would add N visits.
      expect(visits).toBe(15)
      expect(work()).toEqual([0, 0, 0])
      expect(sourceGets()).toHaveLength(0)
      const cursor = journal.cursor()
      await journal.open()
      expect(journal.cursor()).toEqual(cursor)
      expect(journal.queuedMessages.displayState() === display).toBe(false)
      feed.publish(SESSION, journal)
      expect(work()).toEqual([corrections, 1, 1])
      reset()
      await journal.appendItem(
        { provider: 'codex', threadId: 'progress', turnId: 't', ordinal: 0 },
        message('progress'),
        { fence: 0, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
      )
      expect(journal.snapshot().items.at(-1)?.body).toEqual(message('progress'))
      expect(work()).toEqual([0, 0, 0])
      reset()
      feed.publish(SESSION, journal)
      const latest = events.at(-1)
      expect(latest?.type === 'batch' && latest.batch.items.at(-1)?.body).toEqual(
        message('progress')
      )
      expect(work()).toEqual([corrections, 1, 1])
      expect(journal.publicRead().normalizationKey).toBe(key)
    } finally {
      for (const spy of [sets, gets, sorts, json, entriesRead, valuesRead]) {
        spy.mockRestore()
      }
      if (!adopt) {
        db().exec('DROP TRIGGER b2_perf_fail_import')
      }
    }
    expect(events.filter((event) => event.type === 'snapshot')).toHaveLength(2)
    await journal.close()
  }
)

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
  expect(key).not.toBe('')
  const cursor = journal.cursor()
  db().exec('DROP TRIGGER b2_source_fail_import')
  await journal.queuedMessages.importAtOpen()
  expect(journal.cursor()).toEqual(cursor)
  expect(legacyIds()).toEqual([])
  journal.snapshot()
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
    await rig.host.conversationCommand(CALLER, {
      ...clear,
      envelope: rig.envelope(clear, 'agentSession.conversationCommand', hostTestOperationId())
    })
  ).toMatchObject({ ok: true })
  const target = rig.send('rewound away')
  expect(await target.result).toMatchObject({ ok: true })
  await eventually(async () =>
    expect((await rig.submission(target.id))?.handedOverAt).toBeDefined()
  )
  await rig.settleAccepted(target.id, 'target')
  await rig.host.close(SESSION, 'evict')
  await earlier.open()
  const fence = rig.store.getRecord(SESSION)!.lease.runtimeFence
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
  expect(await rig.drafts()).toEqual(held)
  db().exec('DROP TRIGGER fail_import')
  warned.mockRestore()

  const live = rig.host.collaboratorsForTests().sessions.get(SESSION)!.journal
  const rewound = { itemId: agentJournalSubmissionKey(target.id), expectedEpoch: live.epoch }
  expect(
    await rig.host.rewind(CALLER, {
      ...rewound,
      envelope: rig.envelope(rewound, 'agentSession.rewind', hostTestOperationId())
    })
  ).toMatchObject({ ok: true })
  expect(live.epoch).toBe(rewound.expectedEpoch)
  expect(live.submission('att-refused')).toBeUndefined()
  expect(await rig.drafts()).toEqual(held)
  await nothingSentTo('edited')
  expect(legacyIds()).toEqual([])
})

const retainedHistoryCases = [
  { adopt: false, proof: 'none' },
  { adopt: true, proof: 'none' },
  { adopt: false, proof: 'dispatch' },
  { adopt: true, proof: 'item' }
]
it.each(retainedHistoryCases)('retained history: $adopt / $proof', async ({ adopt, proof }) => {
  const earlier = journalFor(SESSION)
  await earlier.open()
  const append = async (journal: AgentSessionJournal, ordinal: number) => {
    await journal.appendItem(
      { provider: 'codex', threadId: 'history', turnId: 't', ordinal },
      { ...message('x'.repeat(4_000)), role: 'assistant' },
      { fence: 0, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
  }
  await append(earlier, 0)
  await handOff(
    earlier,
    'u',
    'q',
    'stopped words',
    'cancelled',
    0,
    async () => {
      for (let index = 1; index <= 205; index++) {
        await append(earlier, index)
      }
    },
    proof === 'none'
      ? undefined
      : {
          turn: { provider: 'codex', threadId: 'history', turnId: 't', ordinal: -1 },
          via: 'steer'
        }
  )
  const stale = readAgentSessionHistory(earlier, { sessionId: SESSION, direction: 'tail' })
  expect(stale.ok).toBe(true)
  await earlier.close()
  seedLegacy(SESSION, [['q', 'waiting', 'stopped words']])
  if (!adopt) {
    db().exec(`CREATE TEMP TRIGGER b2_fail_import BEFORE DELETE ON queued_messages
    BEGIN SELECT RAISE(ABORT, 'disk full'); END`)
  }
  const journal = journalFor(SESSION)
  await journal.open()
  if (!adopt) {
    db().exec('DROP TRIGGER b2_fail_import')
  }
  const queue = { queuedMessages: [], queuePause: null, nextQueuedMessageId: null }
  const feed = new AgentSessionSubscribers({ readQueuePublication: () => queue })
  const base = { sessionId: SESSION, journal, fence: 0 }
  const oldEvents: AgentSessionSubscribeEvent[] = []
  feed.open({
    ...base,
    id: 'old',
    cursor: journal.cursor(),
    snapshotCatchUp: false,
    readsCurrentRequests: false,
    emit: (event) => oldEvents.push(event)
  })
  expect(oldEvents).toEqual([
    {
      type: 'batch',
      sessionId: SESSION,
      fence: 0,
      hostNow: expect.any(Number),
      activity: null,
      ...queue,
      batch: { cursor: journal.cursor(), items: [], removedItemIds: [], submissions: [] }
    }
  ])
  const corrected: AgentSessionSubscribeEvent[][] = []
  const clients: (() => ReturnType<typeof reduceStructuredAgentSession>)[] = []
  for (const boundedFrames of [false, true]) {
    let state = reduceStructuredAgentSession(EMPTY_STRUCTURED_AGENT_SESSION, {
      type: 'history-page',
      page: structuredClone(stale.page)
    })
    const events: AgentSessionSubscribeEvent[] = []
    corrected.push(events)
    clients.push(() => state)
    const reader = subscriberHistoryReader({ boundedFrames })
    feed.open({
      ...base,
      id: `new-${boundedFrames}`,
      cursor: journal.cursor(),
      boundedFrames,
      snapshotCatchUp: true,
      readsCurrentRequests: true,
      emit: (event) => {
        events.push(event)
        state = reduceStructuredAgentSession(state, {
          type: 'event',
          event: structuredClone(event)
        })
      }
    })
    expect(events[0]?.type).toBe('snapshot')
    while (state.hasOlder) {
      const requestedCursor = { epoch: journal.epoch, sequence: state.items[0]!.sequence }
      const older = readAgentSessionHistory(
        journal,
        { sessionId: SESSION, direction: 'before', cursor: requestedCursor },
        { reader }
      )
      expect(older.ok).toBe(true)
      state = reduceStructuredAgentSession(state, {
        type: 'older-page',
        requestedCursor,
        page: structuredClone(older.page)
      })
    }
    const canonical = journal.snapshot()
    expect([state.items, state.submissions]).toEqual([canonical.items, canonical.submissions])
    feed.publish(SESSION, journal)
    await append(journal, 205)
    feed.publish(SESSION, journal)
  }
  const cursor = journal.cursor()
  const after = readAgentSessionHistory(journal, {
    sessionId: SESSION,
    direction: 'after',
    cursor
  })
  expect(after).toMatchObject({ ok: false, reset: 'cursor_compacted' })
  if (!adopt) {
    await journal.queuedMessages.importAtOpen()
    feed.publish(SESSION, journal)
  }
  if (proof !== 'none') {
    const placed = journal
      .snapshot()
      .items.find((item) => item.itemId === agentJournalSubmissionKey('u'))
    const loaded = clients.map((client) => client().items.length)
    const normalizationKey = journal.publicRead().normalizationKey
    const identity = {
      provider: 'codex' as const,
      threadId: 'history',
      turnId: 't',
      ordinal: 206
    }
    if (proof === 'dispatch') {
      await journal.acceptLate({
        clientMessageId: 'u',
        state: 'accepted',
        fence: 0,
        providerIdentity: identity
      })
    }
    await journal.appendItem(identity, message('stopped words'), threadWrite)
    feed.publish(SESSION, journal)
    expect(journal.submission('u')?.dispatchState).toBe('accepted')
    expect(journal.receiptFor('u')).not.toBeNull()
    expect(journal.publicRead().normalizationKey).toBe(normalizationKey)
    expect(clients.map((client) => client().items.length)).toEqual(loaded)
    for (const client of clients) {
      expect(client().items.find((item) => item.itemId === placed?.itemId)).toMatchObject({
        sequence: placed?.sequence,
        observedAt: placed?.observedAt,
        turnScope: placed?.turnScope,
        revision: 1
      })
      expect(
        client().submissions.find((submission) => submission.clientMessageId === 'u')?.dispatchState
      ).toBe('accepted')
    }
  }
  expect(
    corrected.map((events) => events.filter((event) => event.type === 'snapshot').length)
  ).toEqual([1, 1])
  expect(oldEvents.every((event) => event.type === 'batch')).toBe(true)
  await journal.close()
  const reopened = journalFor(SESSION)
  await reopened.open()
  const resumed: AgentSessionSubscribeEvent[] = []
  new AgentSessionSubscribers().open({
    ...base,
    journal: reopened,
    id: 'reopen',
    cursor: reopened.cursor(),
    snapshotCatchUp: true,
    readsCurrentRequests: true,
    emit: (event) => resumed.push(event)
  })
  expect(resumed[0]?.type).toBe('snapshot')
  await reopened.close()
})
