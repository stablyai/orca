import { testJournalNativeDatabase } from './journal-host-database-test-support'
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { JournalHostDatabase } from './journal-host-database'
import * as sweeps from '../agent-session-attachments/agent-session-attachment-sweep'
import { AgentSessionAttachmentStore } from '../agent-session-attachments/agent-session-attachment-store'
import { agentSessionAttachmentStoreRoot } from '../agent-session-attachments/agent-session-attachment-references'
import {
  installAgentSessionAttachments,
  stopAgentSessionAttachments
} from '../../runtime/agent-session/structured-agent-session-attachment-wiring'
import { createStructuredAgentSessionLogger } from '../agent-session-wire/structured-agent-session-logger'

let root: string
let host: JournalHostDatabase | undefined
afterEach(async () => {
  stopAgentSessionAttachments()
  vi.restoreAllMocks()
  await host?.close()
  if (root) {
    await rm(root, { recursive: true, force: true })
  }
})

it.each(['expired', 'resumed', 'orphan', 'partial-prune'])(
  'checkpoints %s cleanup through production wiring after clean idle without a chat write',
  async (path) => {
    root = await mkdtemp(join(tmpdir(), 'orca-checkpoint-sweep-'))
    const database = await JournalHostDatabase.open(root)
    host = database
    const store = new AgentSessionAttachmentStore(agentSessionAttachmentStoreRoot(root), {
      hasSession: () => false
    })
    const upload = join(store.rootDir, 'expired-upload')
    await mkdir(upload, { recursive: true })
    await writeFile(join(upload, 'image.png'), 'bytes')
    const now = 1_700_000_000_000
    const old = new Date(now - sweeps.UNCLAIMED_ATTACHMENT_MAX_AGE_MS - 60000)
    await utimes(upload, old, old)
    const db = testJournalNativeDatabase(database)
    db.exec('BEGIN')
    try {
      if (path === 'resumed') {
        db.prepare('INSERT INTO agent_session_attachment_sweeps VALUES (?, ?)').run(
          'expired-upload',
          1
        )
      }
      if (path === 'orphan' || path === 'partial-prune') {
        const insert = db.prepare('INSERT INTO agent_session_attachment_claims VALUES (?, ?, ?)')
        insert.run('expired-upload', 'gone-session', 1)
        if (path === 'partial-prune') {
          insert.run('other-upload', 'unreadable-session', 1)
        }
      }
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    await database.transaction((plan) => {
      plan.add({
        kind: 'store',
        insertOperationsIfAbsent: false,
        writes: {
          records: { upsert: [], remove: [] },
          operations: { upsert: [], remove: [] },
          retiredClaimKeys: null,
          sessionTabs: null
        }
      })
    })
    let facts: sweeps.AgentSessionAttachmentSweepFacts | undefined
    vi.spyOn(sweeps, 'startAgentSessionAttachmentSweeps').mockImplementation((_store, input) => {
      facts = input
      return { stop: () => undefined }
    })
    installAgentSessionAttachments({
      stateDirectory: root,
      journalDatabase: database,
      store: {
        getRecord: (sessionId) => {
          if (path === 'partial-prune' && sessionId === 'unreadable-session') {
            throw new Error('records unavailable')
          }
          return null
        },
        isSessionUnreadable: () => false
      },
      logger: createStructuredAgentSessionLogger()
    })
    await vi.waitFor(
      () => {
        const frames = db.prepare('PRAGMA wal_checkpoint(NOOP)').get()!
        expect(frames.log).toBe(frames.checkpointed)
      },
      { timeout: 3000 }
    )
    expect(await database['owner'].connection.prepare('PRAGMA wal_autocheckpoint').get()).toEqual({
      wal_autocheckpoint: 0
    })
    expect(facts).toBeDefined()
    const sweep = sweeps.sweepAgentSessionAttachments(store, facts!, now)
    if (path === 'partial-prune') {
      await expect(sweep).rejects.toThrow('records unavailable')
      expect(
        testJournalNativeDatabase(database)
          .prepare('SELECT session_id FROM agent_session_attachment_claims')
          .all()
      ).toEqual([{ session_id: 'unreadable-session' }])
    } else {
      await sweep
      expect(
        testJournalNativeDatabase(database)
          .prepare(
            `SELECT count(*) AS n FROM agent_session_attachment_${path === 'orphan' ? 'claims' : 'sweeps'}`
          )
          .get()?.n
      ).toBe(0)
    }
    await vi.waitFor(
      () => {
        const frames = testJournalNativeDatabase(database)
          .prepare('PRAGMA wal_checkpoint(NOOP)')
          .get()!
        expect(frames.log).toBe(frames.checkpointed)
      },
      { timeout: 3000 }
    )
  }
)
