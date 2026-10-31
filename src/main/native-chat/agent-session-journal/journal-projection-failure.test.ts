import { readJournalLegacyCards } from './journal-queue-import'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { agentSessionSendBodyFingerprint } from '../../../shared/structured-agent-session-send-mutation'
import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import {
  closeTestJournalHostDatabases,
  openTestJournalHostDatabase
} from './journal-host-database-test-support'
import { journalInputOrder } from './journal-input-order'
import { encodeJournalState } from './journal-state-codec'
import { JournalStopMarks } from './journal-stop-marks'
import type { JournalHostDatabase } from './journal-host-database'
import type { JournalRow } from './journal-row-schema'
import {
  projectionBase as base,
  projectionEpoch as epoch,
  projectionEpochRow,
  projectionSessionId as sessionId,
  projectionWriter,
  seedOutcomeRows,
  expectProjectionMatches
} from './journal-projection-test-support'

let root: string
let database: JournalHostDatabase
let rig: ReturnType<typeof projectionWriter> | undefined
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-journal-outcomes-failure-'))
  database = openTestJournalHostDatabase(root)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(async () => {
  rig?.queue.markClosed()
  await rig?.queue.drain()
  vi.restoreAllMocks()
  await closeTestJournalHostDatabases()
  await rm(root, { recursive: true, force: true })
})

// The records, the epoch's coverage and the receipt are one write: any failure among them, or at
// COMMIT, refuses the send as main's row insert does, and the live chat adopts nothing.
it('adopts nothing on an outcome, coverage, receipt, outer-abort or COMMIT failure', async () => {
  const user: AgentJournalMessageItem = {
    kind: 'message',
    role: 'user',
    blocks: [{ type: 'text', text: 'Continue' }]
  }
  const state = seedOutcomeRows(database, [
    projectionEpochRow,
    {
      ...base(2),
      kind: 'tombstone',
      itemId: 'stop',
      revision: 1,
      stopEvent: { reason: 'user-stop', at: 1_002 }
    },
    ...['C', 'D'].map((id, i): JournalRow => ({
      ...base(i + 3),
      kind: 'queue',
      messageId: id,
      change: {
        op: 'queued',
        body: id === 'C' ? { ...user, command: { name: 'compact' } } : user,
        position: i,
        queuedAt: { epoch, sequence: i + 3 }
      }
    })),
    {
      ...base(5),
      kind: 'submission',
      clientMessageId: 'legacy',
      body: user,
      handoverRecorded: true,
      providerHandle: { kind: 'codex', threadId: 'thread-1' },
      payloadFingerprint: 'legacy'
    }
  ])
  rig = projectionWriter(database, state)
  const writer = rig.writer
  const stops = new JournalStopMarks({ state: rig.state })
  const settle = stops.beginSettle(true)
  const send =
    (id: string) =>
    (seq: number, ts: number): JournalRow => ({
      ...base(seq),
      ts,
      kind: 'submission',
      clientMessageId: id,
      body: user,
      handoverRecorded: true,
      inputOrderContext: {
        source: { epoch, sequence: seq },
        basis: 'observed',
        cut: journalInputOrder(rig!.state()).lineage.at(seq)
      },
      providerHandle: { kind: 'codex', threadId: 'thread-1' },
      payloadFingerprint: agentSessionSendBodyFingerprint(sessionId, user)
    })
  database.db.exec('CREATE TABLE test_receipts (seq INTEGER)')
  const receipt = {
    write: (db: JournalHostDatabase['db'], row?: JournalRow) => {
      db.prepare('INSERT INTO test_receipts VALUES (?)').run(row?.seq ?? 0)
    },
    committed: vi.fn()
  }
  await expect(writer.enqueue(send('preserved'), receipt)).resolves.toMatchObject({ seq: 6 })
  expect(receipt.committed).toHaveBeenCalledOnce()
  expect(rig.state().submissions.has('preserved')).toBe(true)
  expect(stops.latest()?.settle).toBe(settle)
  expectProjectionMatches(database, rig.state())
  database.db
    .prepare(`INSERT INTO queued_messages
    (session_id,message_id,position,body_json,fingerprint,created_at,host_instance,state)
    VALUES (?,?,?,?,?,0,'legacy','waiting')`)
    .run(sessionId, 'overlay', 2, JSON.stringify(user), 'overlay')
  const beforeRead = encodeJournalState(rig.state())
  journalInputOrder(rig.state()).overlay(
    rig.state(),
    readJournalLegacyCards(database.db, rig.state())
  )
  expect(encodeJournalState(rig.state())).toEqual(beforeRead)
  const saved = encodeJournalState(rig.state())
  const live = rig.state()
  const version = journalInputOrder(live).version()
  const clock = journalInputOrder(live).lineage.clock
  const pending = journalInputOrder(live)
    .unsettledSubmissions()
    .map((entry) => entry.clientMessageId)
  const attempt = (id: string) =>
    writer.enqueueRows(
      () => [
        (seq, ts): JournalRow => ({
          ...base(seq),
          ts,
          kind: 'dispatch',
          clientMessageId: 'legacy',
          state: 'accepted',
          providerItemId: null,
          reason: null
        }),
        send(id)
      ],
      receipt
    )
  const unchanged = () => {
    expect(live.inputCards.has('overlay')).toBe(false)
    expect(journalInputOrder(live).version()).toBe(version)
    expect(journalInputOrder(live).lineage.clock).toBe(clock)
    expect(
      journalInputOrder(live)
        .unsettledSubmissions()
        .map((entry) => entry.clientMessageId)
    ).toEqual(pending)
    expect(live.inputEntries.has('legacy')).toBe(true)
    expect(live.inputCards.get('D')?.baseline).toBeDefined()
  }
  const scenarios = [
    [
      'outcome',
      `CREATE TRIGGER failure BEFORE INSERT ON journal_outcomes BEGIN SELECT RAISE(ABORT, 'failure'); END`
    ],
    [
      'coverage',
      `CREATE TRIGGER failure BEFORE UPDATE ON journal_outcome_epochs BEGIN SELECT RAISE(ABORT, 'failure'); END`
    ],
    [
      'receipt',
      `CREATE TRIGGER failure BEFORE INSERT ON test_receipts BEGIN SELECT RAISE(ABORT, 'failure'); END`
    ],
    [
      'outer',
      `CREATE TRIGGER failure BEFORE INSERT ON test_receipts BEGIN SELECT RAISE(ROLLBACK, 'failure'); END`
    ]
  ] as const
  for (const [name, sql] of scenarios) {
    database.db.exec(sql)
    await expect(attempt(name)).rejects.toThrow('failure')
    database.db.exec('DROP TRIGGER failure')
    unchanged()
    expect(rig.state()).toBe(live)
    expect(encodeJournalState(live)).toEqual(saved)
    expect(receipt.committed).toHaveBeenCalledOnce()
    expect(stops.latest()?.settle).toBe(settle)
    expectProjectionMatches(database, live)
  }
  const exec = database.db.exec.bind(database.db)
  const spy = vi.spyOn(database.db, 'exec').mockImplementation((sql) => {
    if (sql === 'COMMIT') {
      throw new Error('injected boundary failure')
    }
    exec(sql)
  })
  await expect(attempt('commit')).rejects.toThrow('injected boundary failure')
  spy.mockRestore()
  unchanged()
  expect(rig.state()).toBe(live)
  expect(encodeJournalState(live)).toEqual(saved)
  expect(stops.latest()?.settle).toBe(settle)
  expect(receipt.committed).toHaveBeenCalledOnce()
  expect(database.db.prepare('SELECT COUNT(*) AS n FROM test_receipts').get()?.n).toBe(1)
  expectProjectionMatches(database, live)
  await attempt('retry')
  expect(live.inputEntries.has('legacy')).toBe(false)
  expect(live.inputEntries.has('retry')).toBe(true)
  expect(live.inputCards.has('overlay')).toBe(true)
  const overlayWrites = database.db
    .prepare(
      "SELECT seq,value_json FROM journal_outcomes WHERE field='inputCards' AND entry_key=? AND deleted=0 ORDER BY seq"
    )
    .all(JSON.stringify('overlay'))
  // Both rows touch the introduced object after the legacy-baseline cleanup in the first row.
  expect(overlayWrites.map((row) => row.seq)).toEqual([live.lastSequence - 1, live.lastSequence])
  expect(overlayWrites.map((row) => row.value_json)).toEqual(
    Array(2).fill(JSON.stringify(['overlay', live.inputCards.get('overlay')]))
  )

  expect(receipt.committed).toHaveBeenCalledTimes(2)
  expectProjectionMatches(database, live)
  const first = rig.state().lastSequence + 1
  await writer.enqueueRows(() => [
    (seq, ts) => ({
      ...base(seq),
      ts,
      kind: 'queue',
      messageId: 'frozen',
      change: { op: 'queued', body: user, position: 1, queuedAt: { epoch, sequence: seq } }
    }),
    (seq, ts) => ({
      ...base(seq),
      ts,
      kind: 'queue',
      messageId: 'frozen',
      change: { op: 'held', holdReason: 'edited' }
    })
  ])
  const contributions = database.db
    .prepare(`SELECT seq, value_json FROM journal_outcomes
    WHERE field = 'queue.cards' AND seq >= ? ORDER BY seq`)
    .all(first)
  expect(
    contributions.map((entry) =>
      typeof entry.value_json === 'string' ? JSON.parse(entry.value_json)[1].holdReason : undefined
    )
  ).toEqual([null, 'edited'])
  expectProjectionMatches(database, rig.state())
})
