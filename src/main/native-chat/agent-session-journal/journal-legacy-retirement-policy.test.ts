import { existsSync } from 'node:fs'
import { expect, it, vi } from 'vitest'
import { journalDomainImportState } from './journal-domain-import-rows'
import { cleanup, fakeLease, profile } from './journal-legacy-retirement.test-fixture'
import { readJournalLegacySourceReceipt } from './database/journal-legacy-source-receipt'
import { legacyDestinationMain } from './journal-legacy-retirement-files'
import { journalDomainDatabasePath } from './database/journal-host-database'
import {
  legacyJournalRetirementMode,
  setLegacyJournalRetirementHost
} from './journal-legacy-retirement-outcome'
import { legacyJournalRetirementSchema } from '../../../shared/telemetry/schemas/telemetry-legacy-journal-retirement-schema'

type Mode = { mode: 'off' | 'report' | 'enforce'; revision: number }
const policy =
  (mode: Mode['mode'], revision = 1) =>
  async (): Promise<Mode> => ({ mode, revision })

const companions = (filename: string) =>
  [filename, `${filename}-wal`, `${filename}-shm`].filter((name) => existsSync(name))

it('in report mode proves once, keeps the original, and deletes only once enforcement is allowed', async () => {
  const events: { outcome: string }[] = []
  setLegacyJournalRetirementHost({
    report: async (event) => events.push(event) > 0,
    mode: async () => ({ mode: 'report', revision: 0 })
  })
  cleanup.push(() => setLegacyJournalRetirementHost(undefined))
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const held = await profile()
  const read = held.readers.legacyProof
  let pages = 0
  held.readers.legacyProof = async (cursor) => {
    pages++
    return read(cursor)
  }
  // No policy known: the proof runs, every chat converts, and the original stays.
  await held.launch('1.0.1', true, undefined, undefined, legacyJournalRetirementMode).run()
  expect(companions(held.filename)).toContain(held.filename)
  expect(journalDomainImportState(held.db, 'unopened').state).toBe('ready')
  expect(pages).toBeGreaterThan(0)
  // The next launch reads the held proof instead of walking every chat again.
  pages = 0
  await held.launch('1.0.1', true, undefined, undefined, policy('report', 0)).run()
  expect(pages).toBe(0)
  expect(companions(held.filename)).toContain(held.filename)
  // Enforcement resumes at the copies, then deletes.
  const cursors: Parameters<typeof read>[0][] = []
  held.readers.legacyProof = async (cursor) => {
    cursors.push(cursor)
    return read(cursor)
  }
  await held.launch('1.0.1', true, undefined, undefined, policy('enforce', 2)).run()
  expect(cursors[0]).toMatchObject({ table: 7, after: null, check: true })
  expect(companions(held.filename)).toEqual([])
  // Reported once per change: held at revision 0 (the repeat launch only logged), then deleted.
  expect(events.map((event) => event.outcome)).toEqual(['proof_complete', 'deleted'])
  for (const event of events) {
    expect(legacyJournalRetirementSchema.safeParse(event).success).toBe(true)
    expect(JSON.stringify(event)).not.toContain(held.root)
    expect(JSON.stringify(event)).not.toContain('unopened')
  }
})

it('runs no proof when off, and never unlinks once enforcement is withdrawn', async () => {
  const off = await profile()
  const read = off.readers.legacyProof
  let pages = 0
  off.readers.legacyProof = async (cursor) => {
    pages++
    return read(cursor)
  }
  await off.launch('1.0.1', true, undefined, undefined, policy('off')).run()
  expect(pages).toBe(0)
  expect(companions(off.filename)).toContain(off.filename)
  expect(journalDomainImportState(off.db, 'unopened').state).toBe('converting')

  // Enforce when the proof starts, report by the time it would delete: held, not unlinked.
  const withdrawn = await profile()
  const modes: Mode['mode'][] = ['enforce', 'report']
  await withdrawn
    .launch('1.0.1', true, undefined, undefined, async () => ({
      mode: modes.shift() ?? 'report',
      revision: 1
    }))
    .run()
  expect(companions(withdrawn.filename)).toContain(withdrawn.filename)
  expect(
    JSON.parse(
      String(
        withdrawn.db
          .prepare(
            "SELECT value FROM agent_session_store_meta WHERE key='journal.legacy-retirement.v2'"
          )
          .get()!.value
      )
    )
  ).toMatchObject({ phase: 'held', layout: 2 })
})

it('never resumes progress an older build saved, or saves progress an older build would resume', async () => {
  const older = await profile()
  const proof = JSON.stringify(await readJournalLegacySourceReceipt(older.filename))
  const store = await legacyDestinationMain(journalDomainDatabasePath(older.root))
  // A 265/266 cursor past the inventory, under layout 1.
  older.db.prepare('INSERT OR REPLACE INTO agent_session_store_meta(key,value) VALUES(?,?)').run(
    'journal.legacy-retirement.v2',
    JSON.stringify({
      version: 2,
      phase: 'proving',
      layout: 1,
      proof,
      store,
      cursor: { table: 7, after: null }
    })
  )
  const read = older.readers.legacyProof
  const cursors: Parameters<typeof read>[0][] = []
  older.readers.legacyProof = async (cursor) => {
    cursors.push(cursor)
    return read(cursor)
  }
  await older.launch('1.0.1', true, undefined, undefined, policy('report')).run()
  expect(cursors[0]).toEqual({ table: 0, after: null })
  const saved = JSON.parse(
    String(
      older.db
        .prepare(
          "SELECT value FROM agent_session_store_meta WHERE key='journal.legacy-retirement.v2'"
        )
        .get()!.value
    )
  )
  expect(saved.layout).not.toBe(1)
})

it('reports a refusal an older build saved, and full counts for a walk that resumed', async () => {
  const events: Record<string, unknown>[] = []
  setLegacyJournalRetirementHost({
    report: async (event) => events.push(event) > 0,
    mode: async () => ({ mode: 'report', revision: 0 })
  })
  cleanup.push(() => setLegacyJournalRetirementHost(undefined))
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  // A 265/266 refusal: policy 3 and no artifact field.
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
  await refused.launch('1.0.1', true, undefined, undefined, legacyJournalRetirementMode).run()
  expect(events).toMatchObject([{ outcome: 'refused', reason: 'source-orphan', artifact: 'none' }])
  expect(legacyJournalRetirementSchema.safeParse(events[0]).success).toBe(true)

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
  await many.launch('1.0.1', true, undefined, undefined, policy('report', 0)).run()
  expect(events).toMatchObject([{ outcome: 'proving', error: 'interrupted' }])
  many.readers.legacyProof = read
  await many.launch('1.0.1', true, undefined, undefined, policy('report', 0)).run()
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

it('rechecks a held proof when enforcement arrives later in the same launch', async () => {
  let mode: Mode = { mode: 'report', revision: 0 }
  const held = await profile()
  const retirement = held.launch('1.0.1', true, undefined, undefined, async () => mode)
  await retirement.run()
  expect(companions(held.filename)).toContain(held.filename)
  // A failure the reconcile records after the hold refuses it, as it would on the next launch.
  held.db.exec(`INSERT INTO agent_session_store_meta VALUES('journal.legacy-failed:unopened',
    '{"revision":null,"error":"original chat unreadable"}')`)
  mode = { mode: 'enforce', revision: 1 }
  const now = performance.now()
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => now + 2 * 3_600_000)
  cleanup.push(() => clock.mockRestore())
  await retirement.run()
  expect(companions(held.filename)).toContain(held.filename)
  expect(String(held.errors.at(-1))).toContain('could not be kept')
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

it('keeps the original when permission is withdrawn before the commit or right before the unlink', async () => {
  // Asked at the start, after the proof, before the durable commit, and right before the unlink.
  for (const [withdrawnAt, kept] of [
    [3, true],
    [4, true],
    [5, false]
  ] as const) {
    const withdrawn = await profile()
    let asked = 0
    const mode = async (): Promise<Mode> => ({
      mode: ++asked >= withdrawnAt ? 'report' : 'enforce',
      revision: 1
    })
    await withdrawn.launch('1.0.1', true, undefined, undefined, mode).run()
    expect(companions(withdrawn.filename).includes(withdrawn.filename)).toBe(kept)
  }
})

it('sends an outcome the usage client dropped again on a later launch, then never again', async () => {
  const sent: string[] = []
  let accepts = false
  setLegacyJournalRetirementHost({
    report: async (event) => {
      sent.push(event.outcome)
      return accepts
    },
    mode: async () => ({ mode: 'report', revision: 0 })
  })
  cleanup.push(() => setLegacyJournalRetirementHost(undefined))
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const held = await profile()
  await held.launch('1.0.1', true, undefined, undefined, legacyJournalRetirementMode).run()
  accepts = true
  await held.launch('1.0.1', true, undefined, undefined, legacyJournalRetirementMode).run()
  await held.launch('1.0.1', true, undefined, undefined, legacyJournalRetirementMode).run()
  expect(sent).toEqual(['proof_complete', 'proof_complete'])
})

it('reports the leftover table an older build left behind, even when it is empty', async () => {
  const events: { outcome: string; reason: string; artifact: string }[] = []
  setLegacyJournalRetirementHost({
    report: async (event) => events.push(event) > 0,
    mode: async () => ({ mode: 'report', revision: 0 })
  })
  cleanup.push(() => setLegacyJournalRetirementHost(undefined))
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const paused = await profile({
    seed: (legacy) => legacy.exec('CREATE TABLE queued_message_pauses (session_id TEXT)')
  })
  await paused.launch('1.0.1', true, undefined, undefined, legacyJournalRetirementMode).run()
  expect(companions(paused.filename)).toContain(paused.filename)
  expect(events).toMatchObject([
    { outcome: 'refused', reason: 'source-inventory', artifact: 'pause_table' }
  ])
})
