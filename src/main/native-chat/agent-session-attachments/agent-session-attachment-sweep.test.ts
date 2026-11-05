import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as FsPromises from 'node:fs/promises'
import type * as Fs from 'node:fs'
import type * as ClaimSweep from './agent-session-attachment-claim-sweep'
const fault = vi.hoisted(
  (): {
    path: string
    sync: boolean
    inspect?: (path: string) => Promise<void>
    completed?: (...args: Parameters<typeof ClaimSweep.sweepAttachmentClaims>) => void
  } => ({
    path: '',
    sync: false
  })
)
vi.mock('./agent-session-attachment-claim-sweep', async (original) => {
  const actual = await original<typeof ClaimSweep>()
  return {
    ...actual,
    sweepAttachmentClaims: async (...args: Parameters<typeof actual.sweepAttachmentClaims>) => {
      const result = await actual.sweepAttachmentClaims(...args)
      fault.completed?.(...args)
      return result
    }
  }
})
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof FsPromises>()
  return {
    ...fs,
    lstat: async (...args: Parameters<typeof fs.lstat>) => {
      await fault.inspect?.(String(args[0]))
      if (fault.sync && String(args[0]).startsWith(fault.path)) {
        throw Object.assign(new Error('probe failed'), { code: 'EACCES' })
      }
      return fs.lstat(...args)
    },
    readdir: (...args: Parameters<typeof fs.readdir>) => {
      if (!fault.sync && String(args[0]) === fault.path) {
        throw Object.assign(new Error('listing failed'), { code: 'EIO' })
      }
      return fs.readdir(...args)
    }
  }
})
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof Fs>()
  return {
    ...fs,
    lstatSync: (...args: Parameters<typeof fs.lstatSync>) => {
      if (fault.sync && String(args[0]).startsWith(fault.path)) {
        throw Object.assign(new Error('probe failed'), { code: 'EACCES' })
      }
      return fs.lstatSync(...args)
    }
  }
})
import type Database from '../../sqlite/sync-database'
import { sweepAttachmentClaims } from './agent-session-attachment-claim-sweep'
import { observeNativeJournalSql } from '../agent-session-journal/journal-native-test-instrumentation'
import type { TestJournalHostDatabase as JournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import type { AgentJournalMessageItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import {
  closeTestJournalHostDatabases,
  openTestJournalHostDatabase
} from '../agent-session-journal/journal-host-database-test-support'
import {
  claimAgentSessionAttachmentsInTransaction,
  isAgentSessionAttachmentExpiredError,
  markUnclaimedUploadForSweep
} from './agent-session-attachment-claims'
import {
  AGENT_SESSION_ATTACHMENT_PART_FILE,
  agentSessionAttachmentStoreRoot
} from './agent-session-attachment-references'
import { AgentSessionAttachmentStore } from './agent-session-attachment-store'
import {
  sweepAgentSessionAttachments,
  startAgentSessionAttachmentSweeps,
  UNCLAIMED_ATTACHMENT_MAX_AGE_MS,
  type AgentSessionAttachmentSweepFacts
} from './agent-session-attachment-sweep'

const HOUR = 60 * 60 * 1000
const NOW = Date.now()
const OLD = UNCLAIMED_ATTACHMENT_MAX_AGE_MS + 1
const SENT = '0b6f8a52-4a3e-4c4e-9a59-1d5d1f2b8c01'
const UNSENT = '7c2d9e10-3f4a-4b5c-8d6e-2f1a0b9c8d02'
const CARRIED = '3e1f0a9b-8c7d-4e6f-a5b4-c3d2e1f0a903'

let stateDirectory: string
let store: AgentSessionAttachmentStore
let journal: JournalHostDatabase
let db: Database.Database
let recorded: Set<string> | null

beforeEach(async () => {
  stateDirectory = await mkdtemp(join(tmpdir(), 'orca-attachment-sweep-'))
  store = new AgentSessionAttachmentStore(agentSessionAttachmentStoreRoot(stateDirectory), {
    hasSession: () => true
  })
  journal = await openTestJournalHostDatabase(stateDirectory)
  db = journal.db
  recorded = new Set(['session-1', 'session-2'])
})

afterEach(async () => {
  fault.path = ''
  fault.sync = false
  fault.inspect = undefined
  fault.completed = undefined
  vi.useRealTimers()
  vi.restoreAllMocks()
  store.clearInFlightForTests()
  await closeTestJournalHostDatabases()
  await rm(stateDirectory, { recursive: true, force: true })
})

function facts(overrides: Partial<AgentSessionAttachmentSweepFacts> = {}) {
  return {
    database: () => journal,
    recordedSessionIds: () => recorded,
    ...overrides
  }
}

async function seedUpload(
  uploadId: string,
  ageMs: number,
  file: string = 'shot.png'
): Promise<string> {
  const uploadDir = join(store.rootDir, uploadId)
  await mkdir(uploadDir, { recursive: true })
  await writeFile(join(uploadDir, file), 'bytes')
  const at = new Date(NOW - ageMs)
  await utimes(uploadDir, at, at)
  return join(uploadDir, file)
}

function claim(sessionId: string, path: string, required = true): void {
  const body: AgentJournalMessageItem = {
    kind: 'message',
    role: 'user',
    blocks: [{ type: 'image-ref', path }]
  }
  db.exec('BEGIN')
  try {
    claimAgentSessionAttachmentsInTransaction(db, {
      stateDirectory,
      sessionId,
      body,
      required,
      now: NOW
    })
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

function claimedSessions(): string[] {
  return db
    .prepare('SELECT session_id FROM agent_session_attachment_claims ORDER BY session_id')
    .all()
    .flatMap((row) =>
      typeof row === 'object' && row !== null && 'session_id' in row ? [String(row.session_id)] : []
    )
}

async function remaining(): Promise<string[]> {
  return (await readdir(store.rootDir).catch(() => [])).sort()
}

describe('sweepAgentSessionAttachments', () => {
  it.each([100, 1_000])(
    'bounds scheduled claim reservations and frozen membership at %s retained claims',
    async (size) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
      await seedUpload(SENT, HOUR)
      recorded = new Set()
      const insert = db.prepare(
        'INSERT INTO agent_session_attachment_claims (upload_id, session_id, claimed_at) VALUES (?, ?, ?)'
      )
      journal.fixtureTransaction(() => {
        for (let i = 0; i < size; i++) {
          const id = `session-${String(i).padStart(5, '0')}`
          recorded!.add(id)
          insert.run(SENT, id, NOW)
        }
      })
      let scans = 0
      let discoveries = 0
      const scan = journal.scan.bind(journal)
      const observedScan: typeof journal.scan = async (run) => {
        scans++
        discoveries++
        try {
          return await scan(run)
        } finally {
          scans--
        }
      }
      vi.spyOn(journal, 'scan').mockImplementation(observedScan)
      const counts: number[] = []
      let page = -1
      let settled = false
      let entered!: () => void
      let release!: () => void
      let completed!: () => void
      let successes = 0
      const held = new Promise<void>((resolve) => {
        release = resolve
      })
      const inspecting = new Promise<void>((resolve) => {
        entered = resolve
      })
      const finished = new Promise<void>((resolve) => {
        completed = resolve
      })
      const sweepFacts = facts({
        recordedSessionIds: () => {
          expect(scans).toBe(0)
          page++
          counts[page] = 0
          if (page === 1) {
            expect(settled).toBe(true)
          }
          return recorded
        }
      })
      fault.completed = (actualStore, actualFacts) => {
        expect(actualStore).toBe(store)
        expect(actualFacts).toBe(sweepFacts)
        successes++
        completed()
      }
      fault.inspect = async () => {
        expect(scans).toBe(0)
        counts[page]++
        if (page === 0 && counts[page] === 1) {
          entered()
          await held
        }
      }
      const errors: unknown[] = []
      let observedError!: () => void
      const errored = new Promise<void>((resolve) => {
        observedError = resolve
      })
      let largest = 0
      const pageSql = new Set<string>()
      const stopNative = observeNativeJournalSql(journal, (entry) => {
        if (entry.method === 'prepare') {
          if (entry.sql.includes('LIMIT 32')) {
            pageSql.add(entry.sql)
          }
        } else {
          largest = Math.max(largest, entry.rows, entry.changes)
        }
      })
      const sweeper = startAgentSessionAttachmentSweeps(store, sweepFacts, {
        initialDelayMs: 1,
        intervalMs: 100_000,
        onError: (error) => {
          errors.push(error)
          observedError()
        }
      })
      try {
        await vi.advanceTimersByTimeAsync(1)
        await inspecting
        const foreground = journal.transaction(
          (plan) => {
            plan.add({
              kind: 'sweep',
              operation: { kind: 'mark', uploadId: 'unrelated', now: NOW }
            })
          },
          false,
          () => {
            settled = true
            // Both keys are new after the membership snapshot: neither extends this invocation.
            journal.fixtureTransaction(() => {
              for (const id of ['session-00032-ahead', 'a-behind']) {
                insert.run(SENT, id, NOW)
              }
            })
          }
        )
        release()
        await foreground
        await finished
        await new Promise<void>((resolve) => setImmediate(resolve))
        stopNative()
        expect(errors).toEqual([])
        expect(successes).toBe(1)
        expect(counts.reduce((a, b) => a + b, 0)).toBe(size)
        expect(Math.max(...counts)).toBeLessThanOrEqual(32)
        // One released upper-bound read, then at most ceil(N/32)+1 released 32-claim pages; each
        // page's transaction is its only write admission, and no native call grows with N.
        expect(discoveries).toBeLessThanOrEqual(Math.ceil(size / 32) + 2)
        expect(counts).toHaveLength(Math.ceil(size / 32))
        expect(largest).toBeLessThanOrEqual(32)
        expect(pageSql.size).toBe(1)
        const plan = db
          .prepare(`EXPLAIN QUERY PLAN ${[...pageSql][0]}`)
          .all('0', '9223372036854775807')
          .map((row) => row.detail)
          .join(' ')
        expect(plan).toContain('SEARCH')
        expect(plan).not.toContain('TEMP B-TREE')
        expect(claimedSessions()).toHaveLength(size + 2)
        expect(
          db.prepare('SELECT COUNT(*) AS n FROM agent_session_attachment_sweeps').get()?.n
        ).toBe(1)
        // The scheduled successor rediscovers both arrivals and prunes exactly their definitive absence.
        const transaction = journal.transaction.bind(journal)
        const pruneSizes: number[] = []
        const observedTransaction: typeof journal.transaction = (prepare, streamed, committed) =>
          transaction(
            async (plan) => {
              const result = await prepare(plan)
              for (const effect of plan.effects) {
                if (effect.kind === 'sweep' && effect.operation.kind === 'prune') {
                  pruneSizes.push(effect.operation.pairs.length)
                }
              }
              return result
            },
            streamed,
            committed
          )
        vi.spyOn(journal, 'transaction').mockImplementation(observedTransaction)
        let nextFinished!: () => void
        const next = new Promise<void>((resolve) => {
          nextFinished = resolve
        })
        completed = nextFinished
        await vi.advanceTimersByTimeAsync(100_000)
        await next
        await new Promise<void>((resolve) => setImmediate(resolve))
        expect(errors).toEqual([])
        expect(successes).toBe(2)
        expect(claimedSessions()).toHaveLength(size)
        expect(pruneSizes.reduce((a, b) => a + b, 0)).toBe(2)
        expect(Math.max(...pruneSizes)).toBeLessThanOrEqual(32)
        recorded!.delete('session-00000')
        let inspected = 0
        const uncertain = new Error('later-page uncertain inspection')
        fault.inspect = async () => {
          if (++inspected === 40) {
            throw uncertain
          }
        }
        await vi.advanceTimersByTimeAsync(100_000)
        await errored
        await new Promise<void>((resolve) => setImmediate(resolve))
        expect(errors).toEqual([uncertain])
        expect(successes).toBe(2)
        expect(claimedSessions()).toHaveLength(size - 1)
        expect(claimedSessions()).not.toContain('session-00000')
        fault.inspect = undefined
        let retried!: () => void
        const retry = new Promise<void>((resolve) => {
          retried = resolve
        })
        completed = retried
        await vi.advanceTimersByTimeAsync(100_000)
        await retry
        await new Promise<void>((resolve) => setImmediate(resolve))
        expect(errors).toEqual([uncertain])
        expect(successes).toBe(3)
        expect(claimedSessions()).toHaveLength(size - 1)
        expect(await readFile(join(store.rootDir, SENT, 'shot.png'), 'utf8')).toBe('bytes')
      } finally {
        stopNative()
        release()
        sweeper.stop()
      }
    }
  )

  it('excludes recreated pairs and a deleted maximum until the successor', async () => {
    const insert = db.prepare(
      'INSERT INTO agent_session_attachment_claims (upload_id, session_id, claimed_at) VALUES (?, ?, ?)'
    )
    journal.fixtureTransaction(() => {
      for (let i = 0; i < 65; i++) {
        insert.run(SENT, `s-${i}`, NOW)
      }
    })
    recorded = new Set()
    const transaction = journal.transaction.bind(journal)
    let replaced = false
    const replacing: typeof journal.transaction = (prepare, streamed, committed) => {
      if (!replaced) {
        replaced = true
        journal.fixtureTransaction(() => {
          // Recreating the maximum first would reuse its rowid without AUTOINCREMENT.
          for (const id of ['s-64', 's-0']) {
            db.prepare('DELETE FROM agent_session_attachment_claims WHERE session_id = ?').run(id)
            insert.run(SENT, id, NOW)
          }
        })
      }
      return transaction(prepare, streamed, committed)
    }
    vi.spyOn(journal, 'transaction').mockImplementation(replacing)
    await sweepAttachmentClaims(store, facts())
    expect(claimedSessions()).toEqual(['s-0', 's-64'])
    await sweepAttachmentClaims(store, facts())
    expect(claimedSessions()).toEqual([])
  })

  it('traverses exact identities above the safe integer range through the allocator limit', async () => {
    const insert = db.prepare(
      'INSERT INTO agent_session_attachment_claims (claim_id, upload_id, session_id, claimed_at) VALUES (CAST(? AS INTEGER), ?, ?, ?)'
    )
    const ids = ['9007199254740991', '9007199254740992', '9007199254740993', '9223372036854775807']
    for (const id of ids) {
      insert.run(id, SENT, id, NOW)
    }
    recorded = new Set()
    await sweepAttachmentClaims(store, facts())
    expect(claimedSessions()).toEqual([])
    expect(() =>
      db
        .prepare(
          'INSERT INTO agent_session_attachment_claims (upload_id, session_id, claimed_at) VALUES (?, ?, ?)'
        )
        .run(SENT, 'exhausted', NOW)
    ).toThrow()
  })

  it('removes a part file nobody finished after an hour, and keeps a fresh one', async () => {
    await seedUpload(SENT, HOUR + 1, AGENT_SESSION_ATTACHMENT_PART_FILE)
    await seedUpload(UNSENT, HOUR - 1000, AGENT_SESSION_ATTACHMENT_PART_FILE)
    await sweepAgentSessionAttachments(store, facts(), NOW)
    expect(await remaining()).toEqual([UNSENT])
  })

  it('removes an upload nobody claimed after 7 days, and keeps a claimed one and a fresh one', async () => {
    claim('session-1', await seedUpload(SENT, OLD))
    await seedUpload(UNSENT, OLD)
    await seedUpload(CARRIED, HOUR)
    const onUploadRemoved = vi.fn()
    const { removed } = await sweepAgentSessionAttachments(store, facts({ onUploadRemoved }), NOW)
    expect(removed).toEqual([join(store.rootDir, UNSENT)])
    expect(onUploadRemoved.mock.calls).toEqual([[join(store.rootDir, UNSENT)]])
    expect(await remaining()).toEqual([SENT, CARRIED].sort())
  })

  it.each(['contents', 'root', 'prune'] as const)(
    'keeps bytes and claims across an uncertain %s read and a healthy retry',
    async (boundary) => {
      const path = await store.storeFile('sent.png', Buffer.from('bytes'))
      const old = new Date(NOW - OLD)
      await utimes(dirname(path), old, old)
      claim('session-1', path)
      fault.path = boundary === 'contents' ? dirname(path) : store.rootDir
      fault.sync = boundary === 'prune'
      await expect(sweepAgentSessionAttachments(store, facts(), NOW)).rejects.toThrow()
      fault.path = ''
      fault.sync = false
      await sweepAgentSessionAttachments(store, facts(), NOW)
      expect(await readFile(path, 'utf8')).toBe('bytes')
      expect(claimedSessions()).toEqual(['session-1'])
    }
  )

  it('keeps an upload any chat still claims: a /clear carry is a second holder', async () => {
    const path = await seedUpload(CARRIED, OLD)
    claim('session-1', path)
    claim('session-2', path, false)
    recorded = new Set(['session-2'])
    await sweepAgentSessionAttachments(store, facts(), NOW)
    expect(await remaining()).toEqual([CARRIED])
    expect(claimedSessions()).toEqual(['session-2'])
    recorded = new Set()
    await sweepAgentSessionAttachments(store, facts(), NOW)
    expect(claimedSessions()).toEqual([])
    await sweepAgentSessionAttachments(store, facts(), NOW)
    expect(await remaining()).toEqual([])
  })

  it('a send after the sweep marked an upload is refused, never sent without its file', async () => {
    const path = await seedUpload(UNSENT, OLD)
    expect(markUnclaimedUploadForSweep(db, UNSENT, NOW)).toBe(true)
    let refused: unknown
    try {
      claim('session-1', path)
    } catch (error) {
      refused = error
    }
    expect(isAgentSessionAttachmentExpiredError(refused)).toBe(true)
    expect(claimedSessions()).toEqual([])
  })

  it('finishes a delete a crashed sweep left marked, then forgets the mark', async () => {
    await seedUpload(UNSENT, HOUR)
    expect(markUnclaimedUploadForSweep(db, UNSENT, NOW)).toBe(true)
    const onUploadRemoved = vi.fn()
    await sweepAgentSessionAttachments(store, facts({ onUploadRemoved }), NOW)
    expect(onUploadRemoved).toHaveBeenCalledWith(join(store.rootDir, UNSENT))
    expect(await remaining()).toEqual([])
    expect(db.prepare('SELECT COUNT(*) AS n FROM agent_session_attachment_sweeps').get()).toEqual({
      n: 0
    })
  })

  it('judges no claim orphaned while the record list is incomplete', async () => {
    claim('session-1', await seedUpload(SENT, OLD))
    recorded = null
    await sweepAgentSessionAttachments(store, facts(), NOW)
    expect(claimedSessions()).toEqual(['session-1'])
    expect(await remaining()).toEqual([SENT])
  })

  it('drops a claim whose upload was removed outside Orca', async () => {
    claim('session-1', await seedUpload(SENT, OLD))
    await rm(join(store.rootDir, SENT), { recursive: true })
    await sweepAgentSessionAttachments(store, facts(), NOW)
    expect(claimedSessions()).toEqual([])
  })

  it('removes only part files when it cannot write claims (a newer Orca wrote the journal)', async () => {
    await seedUpload(UNSENT, OLD)
    await seedUpload(SENT, HOUR + 1, AGENT_SESSION_ATTACHMENT_PART_FILE)
    await sweepAgentSessionAttachments(store, facts({ database: () => null }), NOW)
    expect(await remaining()).toEqual([UNSENT])
  })

  it('leaves an upload in flight alone however old its directory is', async () => {
    const { uploadId } = await store.startUpload({
      callerKey: 'client-a',
      sessionId: 'session-1',
      name: 'a.png',
      byteLength: 1
    })
    const at = new Date(NOW - OLD)
    await utimes(join(store.rootDir, uploadId), at, at)
    await sweepAgentSessionAttachments(store, facts(), NOW)
    expect(await remaining()).toEqual([uploadId])
  })
})
