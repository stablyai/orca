import { mutateTestJournalFixture } from './journal-drained-fixture-test-support'
import { restoreJournalAsync, readJournalRowsAfterCursorAsync } from './journal-async-open'
import {
  updateTestJournalRowJson,
  setTestJournalTrigger,
  setTestJournalOutcomeFormat
} from './journal-native-fixture-test-support'
import type { AgentJournalMessageItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { journalInputSourceBody } from './journal-input-source'
import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { agentJournalSubmissionKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import { journalInputOrder } from './journal-input-order'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { codexProviderHandle } from '../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'
import {
  closeTestJournalHostDatabases,
  openTestJournalHostDatabase,
  liveTestJournalRows
} from './journal-host-database-test-support'
import type { JournalHostDatabase } from './journal-host-database'
import { parseJournalRow, type JournalRow } from './journal-row-schema'
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
import {
  registerRetainedOutcomeContract,
  registerRetainedEchoBoundaryContract
} from './journal-retained-outcomes.spec'

let root: string
let database: JournalHostDatabase
const experimentRoots: string[] = []
const rigs: ReturnType<typeof projectionWriter>[] = []
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-journal-outcome-prefix-'))
  database = await openTestJournalHostDatabase(root)
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
  for (const ownedRoot of experimentRoots.splice(0)) {
    await rm(ownedRoot, { recursive: true, force: true })
  }
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
  await seedProjectionRows(database, [
    projectionEpochRow,
    ...['a', 'b', 'c', 'd'].map((id, index) => item(index + 2, id))
  ])
  const original = await liveTestJournalRows(database, sessionId)
  const rig = projectionWriter(
    database,
    (await database.read((read) => restoreJournalAsync(read, sessionId)))!.state
  )
  rigs.push(rig)
  await rig.writer.enqueue((seq, ts) => ({ ...item(seq, 'b'), ts }))
  // The first record holds only the row's own transition, never a snapshot of the prefix.
  expect(
    await database.read((read) =>
      read
        .prepare(`SELECT field, entry_key, ordinal FROM journal_outcomes
      WHERE field != '$'`)
        .all()
    )
  ).toEqual([{ field: 'items', entry_key: '"b"', ordinal: 'b' }])
  for (const row of [
    (seq: number) => tombstone(seq, 'a'),
    (seq: number) => tombstone(seq, 'c'),
    (seq: number) => item(seq, 'c'),
    (seq: number) => item(seq, 'e')
  ]) {
    await rig.writer.enqueue((seq, ts) => ({ ...row(seq), ts }))
  }

  const rows = await liveTestJournalRows(database, sessionId)
  expect(rows.slice(0, original.length)).toEqual(original)
  expect(rows).toHaveLength(original.length + 1)
  // Shipped readers refuse the marker wherever it sits; it was never written over a row.
  expect(rows.at(-1)?.seq).toBe(original.length + 1)
  expect(parseJournalRow(rows.at(-1)!.rowJson)).toEqual({ ok: false, unreadable: true })
  expect([...rig.state().items.keys()]).toEqual(['b', 'd', 'c', 'e'])
  await expectProjectionMatches(database, rig.state())

  // Catch-up pages the prefix rows, then the record groups, each sequence once.
  const read = async (after: number, limit?: number) =>
    (
      await database.read((read) =>
        readJournalRowsAfterCursorAsync(read, sessionId, epoch, after, limit)
      )
    ).rows.map((row) => row.seq)
  expect(await read(0)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  expect(await read(3, 4)).toEqual([4, 5, 6, 7])
  expect(await read(5, 2)).toEqual([6, 7])
  expect(await read(7)).toEqual([8, 9, 10])
})

it('keeps a record that updated a prefix key when a later prefix fold no longer yields that key', async () => {
  await seedProjectionRows(database, [projectionEpochRow, item(2, 'a'), item(3, 'b')])
  const rig = projectionWriter(
    database,
    (await database.read((read) => restoreJournalAsync(read, sessionId)))!.state
  )
  rigs.push(rig)
  await rig.writer.enqueue((seq, ts) => ({ ...item(seq, 'b'), ts }))
  await rig.writer.enqueue((seq, ts) => ({ ...item(seq, 'c'), ts }))
  // A later reducer reads the old row for b as another item: the prefix no longer holds b.
  await updateTestJournalRowJson(
    database,
    sessionId,
    3,
    JSON.stringify({ ...item(3, 'renamed'), revision: 3 })
  )
  const restored = await database.read((read) => restoreJournalAsync(read, sessionId))
  expect(restored).toMatchObject({ newer: null, damage: null })
  // b keeps its newest value, appended after the prefix and before the tail's own keys.
  expect([...restored!.state.items.keys()]).toEqual(['a', 'renamed', 'b', 'c'])
  expect(restored!.state.items.get('b')).toEqual(rig.state().items.get('b'))
})

it('fences opens and every writer before mutation, while the old parser refuses the founding row', async () => {
  const state = await seedOutcomeRows(database, [projectionEpochRow, item(2)])
  const anchor = (await liveTestJournalRows(database, sessionId))[0]
  expect(anchor && parseJournalRow(anchor.rowJson)).toEqual({ ok: false, unreadable: true })
  const rig = projectionWriter(database, state)
  rigs.push(rig)
  await setTestJournalOutcomeFormat(database, 99)
  expect(await database.read((read) => restoreJournalAsync(read, sessionId))).toMatchObject({
    newer: { sequence: 1 },
    damage: null
  })
  const before = await database.read((read) =>
    read.prepare('SELECT * FROM journal_outcomes ORDER BY seq, field, entry_key').all()
  )
  await expect(rig.writer.enqueue((seq) => item(seq))).rejects.toMatchObject({
    code: 'journal_read_only'
  })
  expect(
    await database.read((read) =>
      read.prepare('SELECT * FROM journal_outcomes ORDER BY seq, field, entry_key').all()
    )
  ).toEqual(before)
  expect(rig.state()).toBe(state)
  // Missing remains distinct from unsupported for ACP's resume and loss-warning decisions.
  expect(await database.read((read) => restoreJournalAsync(read, 'missing-session'))).toBeNull()
})

// The check runs inside the publishing transaction, against the epoch the caller last saw.
it('refuses to publish a new epoch over one the caller did not see, writing nothing', async () => {
  await seedOutcomeRows(database, [projectionEpochRow, item(2)])
  const before = await database.read((read) =>
    read.prepare('SELECT * FROM journal_rows ORDER BY seq').all()
  )
  const committed = vi.fn()
  await expect(
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
  ).rejects.toMatchObject({ code: 'journal_row_rejected' })
  expect(committed).not.toHaveBeenCalled()
  expect(
    await database.read((read) => read.prepare('SELECT * FROM journal_rows ORDER BY seq').all())
  ).toEqual(before)
  expect((await database.read((read) => restoreJournalAsync(read, sessionId)))?.state.epoch).toBe(
    epoch
  )
})

const historicalFixture = z
  .object({
    main: z.literal('981ad63bbfc020e02a7b3ab3bd48c298f85a88d4'),
    branch: z.literal('6d34b4e5a391d485b5e41195d88152d9f1512fdf'),
    cleaner: z.literal('af1ee720dd7bc0ed450dba17efdeb9ba14291e65'),
    prefix: frozenDatabase(),
    raw: frozenDatabase(),
    stopped: frozenDatabase(),
    cleanedStoppedKeys: z.array(z.tuple([z.number(), z.string(), z.string()])),
    frozen: z.unknown(),
    publicSnapshot: z.unknown(),
    oldStoppedCarry: z.unknown(),
    rawSources: z.unknown(),
    admission: z.unknown(),
    sourceSha256: z.record(z.string(), z.string())
  })
  .parse(
    JSON.parse(
      readFileSync(
        new URL('./__fixtures__/journal-historical-inputs.json', import.meta.url),
        'utf8'
      )
    )
  )

function frozenDatabase() {
  return z.object({
    session: z.object({ session_id: z.string(), workspace_id: z.string(), epoch: z.string() }),
    rows: z.array(z.tuple([z.number(), z.number(), z.string()])),
    source: z
      .object({
        session_id: z.string(),
        epoch: z.string(),
        generation: z.number(),
        format: z.number(),
        through_seq: z.number(),
        prefix_seq: z.number()
      })
      .nullable(),
    outcomes: z.array(
      z.tuple([z.number(), z.string(), z.string(), z.number(), z.string(), z.string(), z.number()])
    )
  })
}

// Exact rows/outcomes and public values captured from the pinned writers, before/after real cleanup.
async function seedFrozen(
  db: JournalHostDatabase,
  fixture: z.output<ReturnType<typeof frozenDatabase>>
) {
  await mutateTestJournalFixture(db, (connection) => {
    connection
      .prepare('INSERT INTO journal_sessions VALUES (?, ?, ?)')
      .run(fixture.session.session_id, fixture.session.workspace_id, fixture.session.epoch)
    const insert = connection.prepare(
      'INSERT INTO journal_rows (session_id,epoch,seq,ts,row_json) VALUES (?,?,?,?,?)'
    )
    for (const [seq, ts, json] of fixture.rows) {
      insert.run(sessionId, epoch, seq, ts, json)
    }
    const source = fixture.source
    if (source) {
      connection
        .prepare('INSERT INTO journal_outcome_generations VALUES (?,?,?)')
        .run(source.generation, sessionId, epoch)
      connection
        .prepare('INSERT INTO journal_outcome_epochs VALUES (?,?,?,?,?,?)')
        .run(
          sessionId,
          epoch,
          source.generation,
          source.format,
          source.through_seq,
          source.prefix_seq
        )
      const outcome = connection.prepare('INSERT INTO journal_outcomes VALUES (?,?,?,?,?,?,?,?)')
      for (const row of fixture.outcomes) {
        outcome.run(source.generation, ...row)
      }
    }
  })
}

it('main-outcome-old-prefix-source-roundtrip', async () => {
  const readJournalHistoricalInputs = async (db: JournalHostDatabase, id: string) => {
    const load = await db.read((read) => restoreJournalAsync(read, id))
    return load && { load, sources: load.state.inputs.sources }
  }
  const { strictJournalInputSource } = await import('./journal-input-source-schema')
  const { encodeJournalState } = await import('./journal-state-codec')
  const { renderJournalState } = await import('./journal-reducer')
  const { carriedStoppedHistory } =
    await import('../agent-session-wire/structured-agent-session-stopped-history-selection')
  const { AGENT_JOURNAL_THREAD_SCOPE } =
    await import('../../../shared/agent-session/journal/agent-session-journal-types')
  const words = (text: string): AgentJournalMessageItem => ({
    kind: 'message',
    role: 'user',
    blocks: [{ type: 'text', text }]
  })
  await seedFrozen(database, historicalFixture.prefix)
  const before = await liveTestJournalRows(database, sessionId)
  const current = (await readJournalHistoricalInputs(database, sessionId))!.load
  expect(current).toMatchObject({ newer: null, damage: null })
  const encoded = encodeJournalState(current.state)
  const { inputEntries, inputCards, ...common } = z
    .record(z.string(), z.unknown())
    .parse(JSON.parse(encoded.stateJson))
  expect(inputEntries).toEqual([])
  expect(inputCards).toEqual([])
  expect({ ...encoded, stateJson: JSON.stringify(common) }).toEqual(historicalFixture.frozen)
  expect(renderJournalState(current.state)).toEqual(historicalFixture.publicSnapshot)
  expect(journalInputSourceBody(current.state.inputs.sources.get('U'))).toEqual(words('original U'))
  expect(journalInputSourceBody(current.state.inputs.sources.get('V'))).toEqual(words('edited Q'))
  expect([...current.state.submissions]).toEqual([])
  expect([...current.state.inputs.candidates]).toEqual([])
  expect([...current.state.items.keys()]).toEqual(['survivor-a', 'survivor-b'])
  expect(current.state.queue.cards.get('Q')).toMatchObject({
    state: 'withdrawn',
    body: words('final edit')
  })
  expect(await liveTestJournalRows(database, sessionId)).toEqual(before)
  expect(JSON.parse(before.at(-1)!.rowJson)).toMatchObject({ v: 5 })

  const rawRoot = await mkdtemp(join(tmpdir(), 'orca-32267-raw-fixture-'))
  experimentRoots.push(rawRoot)
  const rawDb = await openTestJournalHostDatabase(rawRoot)
  await seedFrozen(rawDb, historicalFixture.raw)
  const raw = (await readJournalHistoricalInputs(rawDb, sessionId))!.load
  expect(raw).toMatchObject({ newer: null, damage: null })
  expect([...raw.state.inputs.sources]).toEqual(historicalFixture.rawSources)
  expect(raw.state.queue.cards.get('raw-Q')?.recovers).toBe('raw-U')
  const unsupported = (await liveTestJournalRows(rawDb, sessionId))
    .at(-1)!
    .rowJson.replace('recovers', 'notADeclaredSource')
  expect(parseJournalRow(unsupported, true)).toEqual({ ok: false, unreadable: true })

  const { startJournalOutcomeLog, JOURNAL_OUTCOME_MARKER_VERSION } =
    await import('./journal-outcome-format')
  const rawPrefix = await liveTestJournalRows(rawDb, sessionId)
  await mutateTestJournalFixture(rawDb, (db) => {
    startJournalOutcomeLog(db, sessionId, epoch, raw.state.lastSequence, 20_000)
    const marker = { v: 6, kind: 'outcomes', epoch, seq: raw.state.lastSequence + 1, ts: 20_000 }
    db.prepare('UPDATE journal_rows SET row_json=? WHERE session_id=? AND epoch=? AND seq=?').run(
      JSON.stringify(marker),
      sessionId,
      epoch,
      marker.seq
    )
  })
  expect(JOURNAL_OUTCOME_MARKER_VERSION).toBe(6)
  expect((await liveTestJournalRows(rawDb, sessionId)).slice(0, rawPrefix.length)).toEqual(
    rawPrefix
  )
  const dispatchedRaw = (await readJournalHistoricalInputs(rawDb, sessionId))!.load
  expect(dispatchedRaw).toMatchObject({ newer: null, damage: null })
  expect([...dispatchedRaw.state.inputs.sources]).toEqual(historicalFixture.rawSources)
  expect(dispatchedRaw.state.queue.cards.get('raw-Q')?.recovers).toBe('raw-U')
  expect((await rawDb.read((read) => restoreJournalAsync(read, sessionId)))?.newer).toBeNull()

  const stoppedRoot = await mkdtemp(join(tmpdir(), 'orca-32267-stop-fixture-'))
  experimentRoots.push(stoppedRoot)
  let stoppedDb = await openTestJournalHostDatabase(stoppedRoot)
  await seedFrozen(stoppedDb, historicalFixture.stopped)
  const selected = async () => {
    const historical = (await readJournalHistoricalInputs(stoppedDb, sessionId))!
    const state = historical.load.state
    expect(state.submissions.get('stopped-U')).toMatchObject({
      dispatchState: 'rejected',
      rejection: { kind: 'cancelled', neverReachedAgent: true },
      answeredInTurn: null
    })
    const evidence = historical.sources.get('stopped-U')!
    expect(evidence).toEqual(historicalFixture.admission)
    expect(state.inputs.sources.get('stopped-U')).toBe(evidence)
    expect(strictJournalInputSource.safeParse(evidence).success).toBe(true)
    expect(
      strictJournalInputSource.safeParse({
        ...evidence,
        providerHandle: codexProviderHandle('invented')
      }).success
    ).toBe(false)
    expect(evidence).not.toHaveProperty('providerHandle')
    return carriedStoppedHistory(
      {
        journal: {
          context: { floor: () => null },
          inputOrder: journalInputOrder(state),
          submissionBody: (id) => journalInputSourceBody(state.inputs.sources.get(id))
        }
      },
      AGENT_JOURNAL_THREAD_SCOPE,
      state.submissions.get('next')!,
      words('next human words')
    )
  }
  expect(await selected()).toEqual(historicalFixture.oldStoppedCarry)
  const firstItem = historicalFixture.stopped.outcomes.find(
    ([, field, key]) => field === 'items' && key === JSON.stringify('orca:stopped-U')
  )!
  expect(JSON.parse(firstItem[5])).toMatchObject({ revision: 0, sequence: 2, observedAt: 2001 })
  const kept = new Set(historicalFixture.cleanedStoppedKeys.map((key) => JSON.stringify(key)))
  // Apply the exact removal set from the real pinned cleaner; immutable record bytes stay unchanged.
  for (const [seq, field, key] of historicalFixture.stopped.outcomes) {
    if (!kept.has(JSON.stringify([seq, field, key]))) {
      await mutateTestJournalFixture(stoppedDb, (db) =>
        db
          .prepare(
            'DELETE FROM journal_outcomes WHERE generation=1 AND seq=? AND field=? AND entry_key=?'
          )
          .run(seq, field, key)
      )
    }
  }
  expect(kept.size).toBeLessThan(historicalFixture.stopped.outcomes.length)
  await closeTestJournalHostDatabases()
  stoppedDb = await openTestJournalHostDatabase(stoppedRoot)
  expect(await selected()).toEqual(historicalFixture.oldStoppedCarry)
  const wrong = { ...JSON.parse(firstItem[5]), sequence: 999 }
  await mutateTestJournalFixture(stoppedDb, (db) =>
    db
      .prepare(
        "UPDATE journal_outcomes SET value_json=? WHERE generation=1 AND seq=? AND field='items' AND entry_key=?"
      )
      .run(JSON.stringify(wrong), firstItem[0], firstItem[2])
  )
  expect((await readJournalHistoricalInputs(stoppedDb, sessionId))!.sources.has('stopped-U')).toBe(
    false
  )
})

registerRetainedOutcomeContract()

registerRetainedEchoBoundaryContract()
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
    await (path !== 'zero' ? seedProjectionRows : seedOutcomeRows)(database, rows)
    let state = (await database.read((read) => restoreJournalAsync(read, sessionId)))!.state
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
    await setTestJournalOutcomeFormat(database, 1, true)
    const prefix = await liveTestJournalRows(database, sessionId)
    const restored = (await database.read((read) => restoreJournalAsync(read, sessionId)))!
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
    await setTestJournalTrigger(database, {
      name: 'no_upgrade',
      event: 'UPDATE',
      table: 'journal_outcome_epochs',
      message: 'upgrade failed'
    })
    await expect(rig.writer.enqueue((seq) => item(seq, 'upgrade'))).rejects.toThrow(
      'upgrade failed'
    )
    await setTestJournalTrigger(database, { remove: 'no_upgrade' })
    expect(
      (
        await database.read((read) =>
          read
            .prepare(
              "SELECT COUNT(*) AS n FROM journal_outcomes WHERE field IN ('inputEntries','inputCards')"
            )
            .get()
        )
      )?.n
    ).toBe(0)
    expect(rig.state().items.has('upgrade')).toBe(false)
    expect(await liveTestJournalRows(database, sessionId)).toEqual(prefix)
    await rig.writer.enqueue((seq) => item(seq, 'upgrade'))
    expect(
      (
        await database.read((read) =>
          read.prepare('SELECT format FROM journal_outcome_epochs').get()
        )
      )?.format
    ).toBe(2)
    await expectProjectionMatches(database, rig.state())
    const native = await database.read((read) =>
      read
        .prepare(
          "SELECT field, entry_key FROM journal_outcomes WHERE field IN ('inputEntries','inputCards')"
        )
        .all()
    )
    expect(native).toHaveLength(3)
    expect(native).toContainEqual({ field: 'inputEntries', entry_key: '"M"' })
    expect(await liveTestJournalRows(database, sessionId)).toEqual(prefix)
    await rig.writer.enqueue((seq): JournalRow => ({
      ...base(seq),
      kind: 'dispatch',
      clientMessageId: 'M',
      state: 'accepted',
      providerItemId: null,
      reason: null
    }))
    await expectProjectionMatches(database, rig.state())
    expect(
      (await database.read((read) => restoreJournalAsync(read, sessionId)))!.state.inputEntries.size
    ).toBe(0)
    expect(
      journalInputOrder(
        (await database.read((read) => restoreJournalAsync(read, sessionId)))!.state
      ).firstQueued()
    ).toBeUndefined()
    // A later unrelated write cannot revive the old prefix's own component.
    await rig.writer.enqueue((seq) => item(seq, 'after-retirement'))
    expect(
      (await database.read((read) => restoreJournalAsync(read, sessionId)))!.state.inputEntries.size
    ).toBe(0)
  }
)
