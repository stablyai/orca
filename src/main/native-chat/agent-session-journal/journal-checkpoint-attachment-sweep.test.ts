import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import {
  openTestJournalHostDatabase,
  closeTestJournalHostDatabases
} from './journal-host-database-test-support'
import { seedTestAttachmentCleanup } from './journal-native-fixture-test-support'
import { observeNativeJournalTransactions } from './journal-native-test-instrumentation'
import * as sweeps from '../agent-session-attachments/agent-session-attachment-sweep'
import { AgentSessionAttachmentStore } from '../agent-session-attachments/agent-session-attachment-store'
import { agentSessionAttachmentStoreRoot } from '../agent-session-attachments/agent-session-attachment-references'
import {
  installAgentSessionAttachments,
  stopAgentSessionAttachments
} from '../../runtime/agent-session/structured-agent-session-attachment-wiring'
import { createStructuredAgentSessionLogger } from '../agent-session-wire/structured-agent-session-logger'

let root: string
afterEach(async () => {
  stopAgentSessionAttachments()
  vi.restoreAllMocks()
  await closeTestJournalHostDatabases()
  if (root) {
    await rm(root, { recursive: true, force: true })
  }
})

it.each(['expired', 'resumed', 'orphan', 'partial-prune'])(
  'durably commits %s cleanup through production wiring without a chat write',
  async (path) => {
    root = await mkdtemp(join(tmpdir(), 'orca-checkpoint-sweep-'))
    const database = await openTestJournalHostDatabase(root)
    const store = new AgentSessionAttachmentStore(agentSessionAttachmentStoreRoot(root), {
      hasSession: () => false
    })
    const upload = join(store.rootDir, 'expired-upload')
    await mkdir(upload, { recursive: true })
    await writeFile(join(upload, 'image.png'), 'bytes')
    const now = 1_700_000_000_000
    const old = new Date(now - sweeps.UNCLAIMED_ATTACHMENT_MAX_AGE_MS - 60000)
    await utimes(upload, old, old)
    await seedTestAttachmentCleanup(database, path)
    const commits: number[] = []
    const stopObserving = observeNativeJournalTransactions(database, (transaction) => {
      if (transaction.sql === 'COMMIT') {
        commits.push(transaction.synchronous)
      }
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
    expect(facts).toBeDefined()
    const sweep = sweeps.sweepAgentSessionAttachments(store, facts!, now)
    if (path === 'partial-prune') {
      await expect(sweep).rejects.toThrow('records unavailable')
      expect(
        await database.read((read) =>
          read.prepare('SELECT session_id FROM agent_session_attachment_claims').all()
        )
      ).toEqual([{ session_id: 'unreadable-session' }])
    } else {
      await sweep
      expect(
        (
          await database.read((read) =>
            read
              .prepare(
                `SELECT count(*) AS n FROM agent_session_attachment_${path === 'orphan' ? 'claims' : 'sweeps'}`
              )
              .get()
          )
        )?.n
      ).toBe(0)
    }
    stopObserving()
    expect(commits.length).toBeGreaterThan(0)
    expect(commits.every((synchronous) => synchronous === 2)).toBe(true)
    expect(await database.read((read) => read.prepare('PRAGMA journal_mode').get())).toEqual({
      journal_mode: 'delete'
    })
  }
)
