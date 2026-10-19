import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type Database from '../../sqlite/sync-database'
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
  type AgentSessionAttachmentSweepFacts
} from './agent-session-attachment-sweep'

const HOUR = 60 * 60 * 1000
const NOW = Date.now()
const OLD = 24 * HOUR + 1
const SENT = '0b6f8a52-4a3e-4c4e-9a59-1d5d1f2b8c01'
const UNSENT = '7c2d9e10-3f4a-4b5c-8d6e-2f1a0b9c8d02'
const CARRIED = '3e1f0a9b-8c7d-4e6f-a5b4-c3d2e1f0a903'

let stateDirectory: string
let store: AgentSessionAttachmentStore
let db: Database.Database
let recorded: Set<string> | null

beforeEach(async () => {
  stateDirectory = await mkdtemp(join(tmpdir(), 'orca-attachment-sweep-'))
  store = new AgentSessionAttachmentStore(agentSessionAttachmentStoreRoot(stateDirectory), {
    hasSession: () => true
  })
  db = openTestJournalHostDatabase(stateDirectory).db
  recorded = new Set(['session-1', 'session-2'])
})

afterEach(async () => {
  store.clearInFlightForTests()
  closeTestJournalHostDatabases()
  await rm(stateDirectory, { recursive: true, force: true })
})

function facts(overrides: Partial<AgentSessionAttachmentSweepFacts> = {}) {
  return { database: () => db, recordedSessionIds: () => recorded, ...overrides }
}

/** A stored upload (or a bare part file) last touched `ageMs` ago. */
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

  it('removes an upload nobody claimed after a day, and keeps a claimed one and a fresh one', async () => {
    claim('session-1', await seedUpload(SENT, OLD))
    await seedUpload(UNSENT, OLD)
    await seedUpload(CARRIED, HOUR)
    const { removed } = await sweepAgentSessionAttachments(store, facts(), NOW)
    expect(removed).toEqual([join(store.rootDir, UNSENT)])
    expect(await remaining()).toEqual([SENT, CARRIED].sort())
  })

  it('keeps an upload any chat still claims: a /clear carry is a second holder', async () => {
    const path = await seedUpload(CARRIED, OLD)
    claim('session-1', path)
    claim('session-2', path, false)
    // The source chat goes; the replacement still holds the upload.
    recorded = new Set(['session-2'])
    await sweepAgentSessionAttachments(store, facts(), NOW)
    expect(await remaining()).toEqual([CARRIED])
    expect(claimedSessions()).toEqual(['session-2'])
    // Once no chat holds it, it is unclaimed and goes.
    recorded = new Set()
    await sweepAgentSessionAttachments(store, facts(), NOW)
    expect(claimedSessions()).toEqual([])
    await sweepAgentSessionAttachments(store, facts(), NOW)
    expect(await remaining()).toEqual([])
  })

  it('a send after the sweep marked an upload is refused, never sent without its file', async () => {
    const path = await seedUpload(UNSENT, OLD)
    // The sweep wins the race: its mark lands before the claim.
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
    // Marked, then the process died before the files went.
    expect(markUnclaimedUploadForSweep(db, UNSENT, NOW)).toBe(true)
    await sweepAgentSessionAttachments(store, facts(), NOW)
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
