import { existsSync, rmSync } from 'node:fs'
import { expect, it, vi } from 'vitest'
import { journalDomainImportState } from './journal-domain-import-rows'
import { cleanup, fakeLease, profile } from './journal-legacy-retirement.test-fixture'
import { readJournalLegacySourceReceipt } from './database/journal-legacy-source-receipt'
import { legacyDestinationMain } from './journal-legacy-retirement-files'
import { journalDomainDatabasePath } from './database/journal-host-database'
import {
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

it('a build that keeps the file proves once and keeps it; a build that deletes resumes at the copies', async () => {
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
  // A build that deletes resumes at the copies, then deletes.
  await held.launch('1.0.1', true, undefined, undefined, true).run()
  expect(cursors[0]).toMatchObject({ table: 7, after: null, check: true })
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

it('sends an outcome the usage client dropped again on a later launch, then never again', async () => {
  const sent: string[] = []
  let accepts = false
  setLegacyJournalRetirementHost({
    report: async (event) => {
      sent.push(event.outcome)
      return accepts
    }
  })
  cleanup.push(() => setLegacyJournalRetirementHost(undefined))
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const held = await profile()
  await held.launch('1.0.1', true, undefined, undefined, false).run()
  accepts = true
  await held.launch('1.0.1', true, undefined, undefined, false).run()
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
    { outcome: 'refused', reason: 'source-inventory', artifact: 'both' }
  ])
})
