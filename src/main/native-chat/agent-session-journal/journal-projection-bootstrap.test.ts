import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import { journalInputOrder } from './journal-input-order'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import {
  closeTestJournalHostDatabases,
  openTestJournalHostDatabase,
  liveTestJournalRows
} from './journal-host-database-test-support'
import type { JournalHostDatabase } from './journal-host-database'
import { readJournalRowsAfterCursor, restoreJournal } from './journal-open'
import { parseJournalRow } from './journal-row-schema'
import type { JournalRow } from './journal-row-schema'
import { publishNewEpoch } from './journal-epoch-rollover'
import {
  projectionBase as base,
  projectionEpoch as epoch,
  projectionEpochRow,
  projectionSessionId as sessionId,
  seedProjectionRows,
  seedOutcomeRows,
  projectionWriter,
  expectProjectionMatches
} from './journal-projection-test-support'

let root: string
let database: JournalHostDatabase
const rigs: ReturnType<typeof projectionWriter>[] = []
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-journal-outcome-prefix-'))
  database = openTestJournalHostDatabase(root)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(async () => {
  for (const rig of rigs.splice(0)) {
    rig.queue.markClosed()
    await rig.queue.drain()
  }
  vi.restoreAllMocks()
  await closeTestJournalHostDatabases()
  await rm(root, { recursive: true, force: true })
})
const item = (seq: number, itemId = 'stream'): JournalRow => ({
  ...base(seq),
  kind: 'item',
  itemId,
  revision: seq,
  body: { kind: 'status', text: `revision ${seq}` }
})

const tombstone = (seq: number, itemId: string): JournalRow => ({
  ...base(seq),
  kind: 'tombstone',
  itemId,
  revision: seq
})

it("keeps an existing chat's rows byte for byte, starts its records after one appended marker, and reopens prefix plus records as live", async () => {
  // A prefix holding a, b, c, d; then b changes in place, a is deleted, c is deleted and recreated,
  // and e is new: the live map reads b, d, c, e.
  seedProjectionRows(database, [
    projectionEpochRow,
    ...['a', 'b', 'c', 'd'].map((id, index) => item(index + 2, id))
  ])
  const original = liveTestJournalRows(database.db, sessionId)
  const rig = projectionWriter(database, restoreJournal(database.db, sessionId)!.state)
  rigs.push(rig)
  await rig.writer.enqueue((seq, ts) => ({ ...item(seq, 'b'), ts }))
  // The first record holds only the row's own transition, never a snapshot of the prefix.
  expect(
    database.db
      .prepare(`SELECT field, entry_key, ordinal FROM journal_outcomes
      WHERE field != '$'`)
      .all()
  ).toEqual([{ field: 'items', entry_key: '"b"', ordinal: 'b' }])
  for (const row of [
    (seq: number) => tombstone(seq, 'a'),
    (seq: number) => tombstone(seq, 'c'),
    (seq: number) => item(seq, 'c'),
    (seq: number) => item(seq, 'e')
  ]) {
    await rig.writer.enqueue((seq, ts) => ({ ...row(seq), ts }))
  }

  const rows = liveTestJournalRows(database.db, sessionId)
  expect(rows.slice(0, original.length)).toEqual(original)
  expect(rows).toHaveLength(original.length + 1)
  // Shipped readers refuse the marker wherever it sits; it was never written over a row.
  expect(rows.at(-1)?.seq).toBe(original.length + 1)
  expect(parseJournalRow(rows.at(-1)!.rowJson)).toEqual({ ok: false, unreadable: true })
  expect([...rig.state().items.keys()]).toEqual(['b', 'd', 'c', 'e'])
  expectProjectionMatches(database, rig.state())

  // Catch-up pages the prefix rows, then the record groups, each sequence once.
  const read = (after: number, limit?: number) =>
    readJournalRowsAfterCursor(database.db, sessionId, epoch, after, limit).map((row) => row.seq)
  expect(read(0)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  expect(read(3, 4)).toEqual([4, 5, 6, 7])
  expect(read(5, 2)).toEqual([6, 7])
  expect(read(7)).toEqual([8, 9, 10])
})

it('keeps a record that updated a prefix key when a later prefix fold no longer yields that key', async () => {
  seedProjectionRows(database, [projectionEpochRow, item(2, 'a'), item(3, 'b')])
  const rig = projectionWriter(database, restoreJournal(database.db, sessionId)!.state)
  rigs.push(rig)
  await rig.writer.enqueue((seq, ts) => ({ ...item(seq, 'b'), ts }))
  await rig.writer.enqueue((seq, ts) => ({ ...item(seq, 'c'), ts }))
  // A later reducer reads the old row for b as another item: the prefix no longer holds b.
  database.db
    .prepare('UPDATE journal_rows SET row_json = ? WHERE session_id = ? AND seq = 3')
    .run(JSON.stringify({ ...item(3, 'renamed'), revision: 3 }), sessionId)
  const restored = restoreJournal(database.db, sessionId)
  expect(restored).toMatchObject({ newer: null, damage: null })
  // b keeps its newest value, appended after the prefix and before the tail's own keys.
  expect([...restored!.state.items.keys()]).toEqual(['a', 'renamed', 'b', 'c'])
  expect(restored!.state.items.get('b')).toEqual(rig.state().items.get('b'))
})

it('fences opens and every writer before mutation, while the old parser refuses the founding row', async () => {
  const state = seedOutcomeRows(database, [projectionEpochRow, item(2)])
  const anchor = liveTestJournalRows(database.db, sessionId)[0]
  expect(anchor && parseJournalRow(anchor.rowJson)).toEqual({ ok: false, unreadable: true })
  const rig = projectionWriter(database, state)
  rigs.push(rig)
  database.db.prepare('UPDATE journal_outcome_epochs SET format = 99').run()
  expect(restoreJournal(database.db, sessionId)).toMatchObject({
    newer: { sequence: 1 },
    damage: null
  })
  const before = database.db
    .prepare('SELECT * FROM journal_outcomes ORDER BY seq, field, entry_key')
    .all()
  await expect(rig.writer.enqueue((seq) => item(seq))).rejects.toMatchObject({
    code: 'journal_read_only'
  })
  expect(
    database.db.prepare('SELECT * FROM journal_outcomes ORDER BY seq, field, entry_key').all()
  ).toEqual(before)
  expect(rig.state()).toBe(state)
  // Missing remains distinct from unsupported for ACP's resume and loss-warning decisions.
  expect(restoreJournal(database.db, 'missing-session')).toBeNull()
})

// The check runs inside the publishing transaction, against the epoch the caller last saw.
it('refuses to publish a new epoch over one the caller did not see, writing nothing', () => {
  seedOutcomeRows(database, [projectionEpochRow, item(2)])
  const before = database.db.prepare('SELECT * FROM journal_rows ORDER BY seq').all()
  const committed = vi.fn()
  expect(() =>
    publishNewEpoch({
      database,
      identity: {
        sessionId,
        workspaceId: 'ws',
        hostId: 'host',
        agent: 'codex',
        providerHandle: codexProviderHandle('thread-1')
      },
      epoch: 'replacement',
      reason: 'handle_forked',
      fence: 2,
      now: 20_000,
      expectedEpoch: 'an-epoch-replaced-meanwhile',
      queue: { cards: [], receipt: { write: () => {}, committed } },
      onPublished: committed
    })
  ).toThrow(expect.objectContaining({ code: 'journal_row_rejected' }))
  expect(committed).not.toHaveBeenCalled()
  expect(database.db.prepare('SELECT * FROM journal_rows ORDER BY seq').all()).toEqual(before)
  expect(restoreJournal(database.db, sessionId)?.state.epoch).toBe(epoch)
})

// A frozen marker-5 prefix and an outcome-only format-1 chat carry different evidence.
it.each(['prefix', 'zero', 'recreated'] as const)(
  'lifts actual %s evidence once, then treats native tombstones as authoritative',
  async (path) => {
    const user = {
      kind: 'message' as const,
      role: 'user' as const,
      blocks: [{ type: 'text' as const, text: 'M' }]
    }
    const rows: JournalRow[] = [
      projectionEpochRow,
      ...['C', 'D'].map((id, i): JournalRow => ({
        ...base(i + 2),
        kind: 'queue',
        messageId: id,
        change: {
          op: 'queued',
          body: id === 'C' ? { ...user, command: { name: 'compact' } } : user,
          position: i,
          queuedAt: { epoch, sequence: i + 2 }
        }
      })),
      {
        ...base(4),
        kind: 'submission',
        clientMessageId: 'S',
        body: user,
        payloadFingerprint: 'S',
        providerHandle: { kind: 'codex', threadId: 'thread-1' },
        handoverRecorded: true
      },
      {
        ...base(5),
        kind: 'dispatch',
        clientMessageId: 'S',
        state: 'accepted',
        providerItemId: null,
        reason: null
      },
      {
        ...base(6),
        kind: 'submission',
        clientMessageId: 'M',
        body: user,
        payloadFingerprint: 'M',
        providerHandle: { kind: 'codex', threadId: 'thread-1' },
        handoverRecorded: true,
        inputOrderContext: { source: { epoch, sequence: 6 }, basis: 'observed', cut: 6 }
      }
    ]
    if (path !== 'zero') {
      seedProjectionRows(database, rows)
    } else {
      seedOutcomeRows(database, rows)
    }
    let state = restoreJournal(database.db, sessionId)!.state
    const first = projectionWriter(database, state)
    rigs.push(first)
    await first.writer.enqueue((seq, ts): JournalRow => ({
      ...base(seq),
      ts,
      kind: 'queue',
      messageId: 'D',
      change: { op: 'edited', body: { ...user, blocks: [{ type: 'text', text: 'latest D' }] } }
    }))
    if (path === 'recreated') {
      await first.writer.enqueue((seq): JournalRow => ({
        ...base(seq),
        kind: 'tombstone',
        itemId: agentJournalSubmissionKey('M'),
        revision: seq,
        retireSubmission: true
      }))
      await first.writer.enqueue((seq): JournalRow => ({
        ...base(seq),
        kind: 'submission',
        clientMessageId: 'M',
        body: user,
        payloadFingerprint: 'M-recreated',
        providerHandle: { kind: 'codex', threadId: 'thread-1' },
        handoverRecorded: true
      }))
    }
    // These ordinary records are admitted by the frozen format-1 contract; old writers had no native families.
    database.db.exec(
      "DELETE FROM journal_outcomes WHERE field IN ('inputEntries','inputCards'); UPDATE journal_outcomes SET format=1; UPDATE journal_outcome_epochs SET format=1"
    )
    const prefix = liveTestJournalRows(database.db, sessionId)
    const restored = restoreJournal(database.db, sessionId)!
    expect(restored).toMatchObject({ newer: null, damage: null })
    state = restored.state
    expect(state.queue.cards.get('D')?.body.blocks).toEqual([{ type: 'text', text: 'latest D' }])
    expect(journalInputOrder(state).firstQueued()?.clientMessageId).toBe('M')
    expect(journalInputOrder(state).forced('M')).toBe(path === 'prefix')
    expect(state.inputEntries.get('M')?.context.basis).toBe(
      path === 'prefix' ? 'observed' : 'legacy'
    )
    if (path === 'prefix') {
      expect(
        ['C', 'D'].map((id) =>
          journalInputOrder(state).precedes(state.queue.cards.get(id)!, state.submissions.get('M')!)
        )
      ).toEqual([true, true])
    }
    const rig = projectionWriter(database, state)
    rigs.push(rig)
    database.db.exec(
      "CREATE TRIGGER no_upgrade BEFORE UPDATE ON journal_outcome_epochs BEGIN SELECT RAISE(ABORT, 'upgrade failed'); END"
    )
    await expect(rig.writer.enqueue((seq) => item(seq, 'upgrade'))).rejects.toThrow(
      'upgrade failed'
    )
    database.db.exec('DROP TRIGGER no_upgrade')
    expect(
      database.db
        .prepare(
          "SELECT COUNT(*) AS n FROM journal_outcomes WHERE field IN ('inputEntries','inputCards')"
        )
        .get()?.n
    ).toBe(0)
    expect(rig.state().items.has('upgrade')).toBe(false)
    expect(liveTestJournalRows(database.db, sessionId)).toEqual(prefix)
    await rig.writer.enqueue((seq) => item(seq, 'upgrade'))
    expect(database.db.prepare('SELECT format FROM journal_outcome_epochs').get()?.format).toBe(2)
    expectProjectionMatches(database, rig.state())
    const native = database.db
      .prepare(
        "SELECT field, entry_key FROM journal_outcomes WHERE field IN ('inputEntries','inputCards')"
      )
      .all()
    expect(native).toHaveLength(3)
    expect(native).toContainEqual({ field: 'inputEntries', entry_key: '"M"' })
    expect(liveTestJournalRows(database.db, sessionId)).toEqual(prefix)
    await rig.writer.enqueue((seq): JournalRow => ({
      ...base(seq),
      kind: 'dispatch',
      clientMessageId: 'M',
      state: 'accepted',
      providerItemId: null,
      reason: null
    }))
    expectProjectionMatches(database, rig.state())
    expect(restoreJournal(database.db, sessionId)!.state.inputEntries.size).toBe(0)
    expect(
      journalInputOrder(restoreJournal(database.db, sessionId)!.state).firstQueued()
    ).toBeUndefined()
    // A later unrelated write cannot revive the old prefix's own component.
    await rig.writer.enqueue((seq) => item(seq, 'after-retirement'))
    expect(restoreJournal(database.db, sessionId)!.state.inputEntries.size).toBe(0)
  }
)
