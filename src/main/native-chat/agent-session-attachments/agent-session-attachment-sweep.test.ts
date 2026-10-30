import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as FsPromises from 'node:fs/promises'
import type * as Fs from 'node:fs'
const fault = vi.hoisted(() => ({ path: '', sync: false }))
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof FsPromises>()
  return {
    ...fs,
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
import type { JournalHostDatabase } from '../agent-session-journal/journal-host-database'
import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
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
  journal = openTestJournalHostDatabase(stateDirectory)
  db = journal.db
  recorded = new Set(['session-1', 'session-2'])
})

afterEach(async () => {
  fault.path = ''
  fault.sync = false
  store.clearInFlightForTests()
  await closeTestJournalHostDatabases()
  await rm(stateDirectory, { recursive: true, force: true })
})

function facts(overrides: Partial<AgentSessionAttachmentSweepFacts> = {}) {
  return {
    database: () => db,
    write: <T>(run: (db: Database.Database) => T) =>
      overrides.database?.() === null ? undefined : journal.writeAutocommit(run),
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
  it('removes a part file nobody finished after an hour, and keeps a fresh one', async () => {
    await seedUpload(SENT, HOUR + 1, AGENT_SESSION_ATTACHMENT_PART_FILE)
    await seedUpload(UNSENT, HOUR - 1000, AGENT_SESSION_ATTACHMENT_PART_FILE)
    await sweepAgentSessionAttachments(store, facts(), NOW)
    expect(await remaining()).toEqual([UNSENT])
  })

  it('removes an upload nobody claimed after 30 days, and keeps a claimed one and a fresh one', async () => {
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
