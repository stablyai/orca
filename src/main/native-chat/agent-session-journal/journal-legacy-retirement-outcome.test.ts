import { existsSync, readFileSync, rmSync } from 'node:fs'
import { expect, it, vi } from 'vitest'
import { journalDomainImportState } from './journal-domain-import-rows'
import {
  cleanup,
  continueInOlderOrca,
  fakeLease,
  profile
} from './journal-legacy-retirement.test-fixture'
import { readJournalLegacySourceReceipt } from './database/journal-legacy-source-receipt'
import { legacyDestinationMain } from './journal-legacy-retirement-files'
import { journalDomainDatabasePath } from './database/journal-host-database'
import { initializeJournalDomainDatabase } from './database/journal-domain-database'
import {
  LegacyJournalRetirementReporter,
  legacyProofFailureOutcome,
  setLegacyJournalRetirementHost,
  type LegacyJournalRetirementEvent
} from './journal-legacy-retirement-outcome'
import { legacyJournalRetirementSchema } from '../../../shared/telemetry/schemas/telemetry-legacy-journal-retirement-schema'

const companions = (filename: string) =>
  [filename, `${filename}-wal`, `${filename}-shm`].filter((name) => existsSync(name))

function recordEvents(): LegacyJournalRetirementEvent[] {
  const events: LegacyJournalRetirementEvent[] = []
  setLegacyJournalRetirementHost({ report: async (event) => events.push(event) > 0 })
  cleanup.push(() => setLegacyJournalRetirementHost(undefined))
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  return events
}

it('a build that keeps the file proves once and keeps it; a build that deletes proves again in full', async () => {
  const events = recordEvents()
  const held = await profile()
  const read = held.readers.legacyProof
  const cursors: Parameters<typeof read>[0][] = []
  held.readers.legacyProof = async (cursor) => {
    cursors.push(cursor)
    return read(cursor)
  }
  await held.launch('1.0.1', true, undefined, undefined, false).run()
  expect(companions(held.filename)).toContain(held.filename)
  expect(journalDomainImportState(held.db, 'unopened').state).toBe('ready')
  // The next launch of a keeping build reads the held proof instead of walking every chat again.
  cursors.length = 0
  await held.launch('1.0.1', true, undefined, undefined, false).run()
  expect(cursors).toEqual([])
  // A held proof is no standing permission: a build that deletes walks from the start, then deletes.
  await held.launch('1.0.1', true, undefined, undefined, true).run()
  expect(cursors[0]).toEqual({ table: 0, after: null })
  expect(companions(held.filename)).toEqual([])
  // Then the file is gone, and the store remembers deleting it.
  await held.launch('1.0.2', true, undefined, undefined, true).run()
  expect(events.map((event) => [event.outcome, event.deletes])).toEqual([
    ['proof_complete', false],
    ['deleted', true],
    ['deleted_before', true]
  ])
  for (const event of events) {
    expect(legacyJournalRetirementSchema.safeParse(event).success).toBe(true)
    expect(JSON.stringify(event)).not.toContain(held.root)
    expect(JSON.stringify(event)).not.toContain('unopened')
  }
})

it('reports a store that never had the file as absent, with counts unknown rather than zero', async () => {
  const events = recordEvents()
  const none = await profile()
  for (const name of companions(none.filename)) {
    rmSync(name)
  }
  await none.launch().run()
  expect(events).toMatchObject([
    { outcome: 'absent', chats_bucket: 'unknown', drafts_bucket: 'unknown', artifact: 'unknown' }
  ])
  expect(legacyJournalRetirementSchema.safeParse(events[0]).success).toBe(true)
})

it('reports non-ownership once per launch without reading or writing the store after refused sends', async () => {
  const held = await profile()
  const snapshot = () =>
    companions(journalDomainDatabasePath(held.root)).map((name) => readFileSync(name))
  const before = snapshot()
  const events: LegacyJournalRetirementEvent[] = []
  let accepts = false
  setLegacyJournalRetirementHost({
    report: async (event) => {
      events.push(event)
      return accepts
    },
    accepting: () => accepts
  })
  cleanup.push(() => setLegacyJournalRetirementHost(undefined))
  const log = vi
    .spyOn(console, 'warn')
    .mockImplementation(() => {})
    .mockClear()
  const launch = held.launch('1.0.1', false, undefined, undefined, false)
  await launch.run()
  await launch.run()
  accepts = true
  await launch.run()
  await launch.run()
  expect(events).toHaveLength(1)
  expect(log.mock.calls).toEqual([
    [expect.stringContaining('old chat journal: deferred (reason none, defer not_owner,')]
  ])
  await held.launch('1.0.1', false, undefined, undefined, false).run()
  expect(events).toHaveLength(2)
  expect(log.mock.calls).toHaveLength(2)
  for (const event of events) {
    expect(legacyJournalRetirementSchema.parse(event)).toMatchObject({
      outcome: 'deferred',
      defer: 'not_owner',
      deletes: false
    })
  }
  expect(snapshot()).toEqual(before)
  expect(held.errors).toEqual([])
})

it('reports a refusal an older build saved, and full counts for a walk that resumed', async () => {
  const events = recordEvents()
  // A 265/266 refusal: policy 3 and no artifact field, so which shapes it saw is unknown.
  const refused = await profile()
  const proof = JSON.stringify(await readJournalLegacySourceReceipt(refused.filename))
  const store = await legacyDestinationMain(journalDomainDatabasePath(refused.root))
  refused.db.prepare('INSERT OR REPLACE INTO agent_session_store_meta(key,value) VALUES(?,?)').run(
    'journal.legacy-retirement.v2',
    JSON.stringify({
      version: 2,
      phase: 'refused',
      policy: 3,
      proof,
      store,
      reason: 'source-orphan'
    })
  )
  await refused.launch().run()
  expect(events).toMatchObject([
    { outcome: 'refused', reason: 'source-orphan', artifact: 'unknown' }
  ])

  // 600 drafts over more than 16 pages; the first launch stops partway, the next resumes.
  events.length = 0
  const many = await profile({
    seed: (legacy) => {
      const insert = legacy.prepare('INSERT INTO agent_session_records VALUES(?,?)')
      for (let draft = 0; draft < 600; draft++) {
        const id = `draft-${String(draft).padStart(3, '0')}`
        insert.run(id, JSON.stringify({ sessionId: id }))
      }
    }
  })
  const read = many.readers.legacyProof
  let calls = 0
  many.readers.legacyProof = async (cursor) => {
    if (++calls > 17) {
      throw new Error('legacy proof was interrupted')
    }
    return read(cursor)
  }
  await many.launch('1.0.1', true, undefined, undefined, false).run()
  expect(events).toMatchObject([{ outcome: 'proving', error: 'interrupted' }])
  many.readers.legacyProof = read
  await many.launch('1.0.1', true, undefined, undefined, false).run()
  expect(events.at(-1)).toMatchObject({
    outcome: 'proof_complete',
    completeness: 'complete',
    resumed: true,
    chats_bucket: '101_1000'
  })
  for (const event of events) {
    expect(legacyJournalRetirementSchema.safeParse(event).success).toBe(true)
  }
})

it('rechecks a finished proof when a deletion that failed is tried again in the same launch', async () => {
  const retried = await profile()
  let failDelete = true
  const flaky = async (filename: string) => {
    const lease = await fakeLease(filename)
    return { ...lease, retire: async () => (failDelete ? false : lease.retire()) }
  }
  const retirement = retried.launch('1.0.1', true, flaky)
  await retirement.run()
  expect(companions(retried.filename)).toContain(retried.filename)
  retried.db.exec(`INSERT INTO agent_session_store_meta VALUES('journal.legacy-failed:unopened',
    '{"revision":null,"error":"original chat unreadable"}')`)
  failDelete = false
  const now = performance.now()
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => now + 2 * 3_600_000)
  cleanup.push(() => clock.mockRestore())
  await retirement.run()
  expect(companions(retried.filename)).toContain(retried.filename)
  expect(String(retried.errors.at(-1))).toContain('could not be kept')
})

it('sends an outcome the usage client dropped once it takes reports, then never again', async () => {
  const sent: string[] = []
  let accepts = false
  setLegacyJournalRetirementHost({
    report: async (event) => {
      sent.push(event.outcome)
      return accepts
    },
    accepting: () => accepts
  })
  cleanup.push(() => setLegacyJournalRetirementHost(undefined))
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const held = await profile()
  const launch = held.launch('1.0.1', true, undefined, undefined, false)
  await launch.run()
  // Not taking reports yet: a later maintenance tick doesn't send it again.
  await launch.run()
  expect(sent).toEqual(['proof_complete'])
  // Consent given later in the same launch: the next tick sends it, once.
  accepts = true
  await launch.run()
  expect(sent).toEqual(['proof_complete', 'proof_complete'])
  await launch.run()
  await held.launch('1.0.1', true, undefined, undefined, false).run()
  expect(sent).toEqual(['proof_complete', 'proof_complete'])
})

it('reports every leftover shape an older build left behind, even an empty table', async () => {
  const events = recordEvents()
  const paused = await profile({
    seed: (legacy) => legacy.exec('CREATE TABLE queued_message_pauses (session_id TEXT)')
  })
  await paused.launch().run()
  expect(companions(paused.filename)).toContain(paused.filename)
  const both = await profile({
    seed: (legacy) => {
      legacy.exec('CREATE TABLE queued_message_pauses (session_id TEXT)')
      legacy.exec('ALTER TABLE queued_messages ADD COLUMN source_json TEXT')
    }
  })
  await both.launch().run()
  expect(events).toMatchObject([
    { outcome: 'refused', reason: 'source-inventory', artifact: 'pause_table' },
    { outcome: 'refused', reason: 'source-inventory', artifact: 'both', chats_bucket: 'unknown' }
  ])
})

it('reports a deletion only once the source readers are released', async () => {
  const deleted = await profile()
  let released = false
  deleted.readers.releaseSourceReaders = () => {
    released = true
  }
  const seen: [string, boolean][] = []
  setLegacyJournalRetirementHost({
    report: async (event) => seen.push([event.outcome, released]) > 0
  })
  cleanup.push(() => setLegacyJournalRetirementHost(undefined))
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  await deleted.launch().run()
  expect(seen).toEqual([['deleted', true]])
})

it('reports a quit that stops the conversion the proof waits on as interrupted', () => {
  const stopped = new Error('journal maintenance stopped')
  expect(
    legacyProofFailureOutcome(stopped, { counts: null, resumed: false, whole: true }, false)
  ).toMatchObject({
    outcome: 'proving',
    error: 'interrupted'
  })
})

it('reports a later launch of the same outcome again only when the walk got further', async () => {
  const events = recordEvents()
  const many = await profile({
    seed: (legacy) => {
      const insert = legacy.prepare('INSERT INTO agent_session_records VALUES(?,?)')
      for (let draft = 0; draft < 600; draft++) {
        const id = `draft-${String(draft).padStart(3, '0')}`
        insert.run(id, JSON.stringify({ sessionId: id }))
      }
    }
  })
  const read = many.readers.legacyProof
  let limit = 1
  let calls = 0
  many.readers.legacyProof = async (cursor) => {
    if (++calls > limit) {
      throw new Error('legacy proof was interrupted')
    }
    return read(cursor)
  }
  await many.launch('1.0.1', true, undefined, undefined, false).run()
  calls = 0
  // Fewer pages than a progress save takes, so the next launch starts from the first page again.
  limit = 5
  await many.launch('1.0.1', true, undefined, undefined, false).run()
  // Saved progress lags the walk: a launch that restarts below it and stops early isn't news.
  calls = 0
  limit = 1
  await many.launch('1.0.1', true, undefined, undefined, false).run()
  expect(events.map((event) => [event.outcome, event.error, event.chats_bucket])).toEqual([
    ['proving', 'interrupted', '11_100'],
    ['proving', 'interrupted', '101_1000']
  ])
})

it("reports a held save the store doesn't acknowledge, and keeps the file until a later save goes through", async () => {
  const events = recordEvents()
  const held = await profile()
  const maintain = held.writer.maintain.bind(held.writer)
  let failing = true
  held.writer.maintain = async (operation) => {
    if (
      failing &&
      operation.kind === 'legacy-retirement-save' &&
      operation.value.includes('"held"')
    ) {
      throw new Error('database or disk is full')
    }
    return maintain(operation)
  }
  const retirement = held.launch('1.0.1', true, undefined, undefined, false)
  await retirement.run()
  failing = false
  const now = performance.now()
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => now + 2 * 3_600_000)
  cleanup.push(() => clock.mockRestore())
  await retirement.run()
  expect(companions(held.filename)).toContain(held.filename)
  expect(events.map((event) => event.outcome)).toEqual(['proving', 'proof_complete'])
  expect(held.errors).toHaveLength(1)
})

it('reports a refusal found partway through the walk once, not again when a later launch reads it', async () => {
  const events = recordEvents()
  const orphan = await profile({
    seed: (legacy) => {
      const insert = legacy.prepare('INSERT INTO agent_session_records VALUES(?,?)')
      for (let draft = 0; draft < 40; draft++) {
        const id = `draft-${String(draft).padStart(3, '0')}`
        insert.run(id, JSON.stringify({ sessionId: id }))
      }
    }
  })
  const read = orphan.readers.legacyProof
  let calls = 0
  orphan.readers.legacyProof = async (cursor) => {
    if (++calls === 3) {
      return {
        next: null,
        sessions: [],
        retained: 'legacy source has orphan rows',
        reason: 'source-orphan'
      }
    }
    return read(cursor)
  }
  await orphan.launch('1.0.1', true, undefined, undefined, false).run()
  orphan.readers.legacyProof = read
  await orphan.launch('1.0.1', true, undefined, undefined, false).run()
  expect(events.map((event) => [event.outcome, event.reason])).toEqual([
    ['refused', 'source-orphan']
  ])
  expect(companions(orphan.filename)).toContain(orphan.filename)
})

it('reports copies as partial when a quit lost a copy converted before its count was saved', async () => {
  const events = recordEvents()
  const continued = await profile()
  await continued.convert('unopened')
  continueInOlderOrca(continued.filename, 'unopened')
  await initializeJournalDomainDatabase(continued.root)
  const copy = String(
    continued.db
      .prepare(
        "SELECT key FROM agent_session_store_meta WHERE key LIKE 'journal.legacy-copy-source:%'"
      )
      .get()!.key
  ).slice('journal.legacy-copy-source:'.length)
  // The copy converts, then the launch quits before the walk counts it.
  const importState = continued.readers.importState
  continued.readers.importState = async (sessionId) => {
    if (sessionId === copy) {
      throw new Error('legacy proof was interrupted')
    }
    return importState(sessionId)
  }
  await continued.launch('1.0.1', true, undefined, undefined, false).run()
  expect(journalDomainImportState(continued.db, copy).state).toBe('ready')
  continued.readers.importState = importState
  await continued.launch('1.0.1', true, undefined, undefined, false).run()
  expect(events.at(-1)).toMatchObject({ outcome: 'proof_complete', completeness: 'partial' })
})

it('never sends a refused report once a later one returned to what was already sent', async () => {
  const sent: string[] = []
  let accepts = true
  setLegacyJournalRetirementHost({
    report: async (event) => {
      if (accepts) {
        sent.push(`${event.outcome}/${event.error}`)
      }
      return accepts
    },
    accepting: () => accepts
  })
  cleanup.push(() => setLegacyJournalRetirementHost(undefined))
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  let saved: string | null = null
  const writer = {
    maintain: async ({ value }: { value: string }) => {
      saved = value
      return true
    }
  }
  const first = new LegacyJournalRetirementReporter(writer, '1.0.1', false)
  first.saved(null)
  await first.report({ outcome: 'proof_complete' })
  // A later launch: a passing storage error while reports are refused, then the saved proof again.
  const later = new LegacyJournalRetirementReporter(writer, '1.0.1', false)
  later.saved(saved)
  accepts = false
  await later.report({ outcome: 'proving', error: 'storage' })
  await later.report({ outcome: 'proof_complete' })
  accepts = true
  await later.resendUnsent()
  expect(sent).toEqual(['proof_complete/none'])
})
