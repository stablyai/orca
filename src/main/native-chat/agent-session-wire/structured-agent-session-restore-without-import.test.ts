// Startup restore lists a chat that is still in its per-chat file from a read-only fold of that
// file, and copies nothing: the copy waits for the chat's first real read or write, which is
// restore's own only for a chat the last run left mid-work. Restore stays the cost it was when
// every chat had its own file, and opens no file it does not restore.

import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentSessionResumeMarker } from '../../../shared/agent-session-resume-marker'
import { latestStructuredAgentSessionPrompt } from '../../../shared/structured-agent-session-latest-request'
import { AgentSessionRefusalError } from '../../../shared/agent-session-wire-refusals'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import Database from '../../sqlite/sync-database'
import type * as SyncDatabaseModule from '../../sqlite/sync-database'
import {
  closeTestJournalHostDatabases,
  openTestJournalHostDatabase,
  readTestJournalRows
} from '../agent-session-journal/journal-host-database-test-support'
import {
  journalDirectoryFor,
  legacyJournalDatabaseFile
} from '../agent-session-journal/journal-paths'
import {
  readJournalSessionEpoch,
  type JournalStoredRow
} from '../agent-session-journal/journal-row-table'
import { previewPerSessionJournal } from '../agent-session-journal/journal-per-session-import'
import { openAgentSessionJournal } from '../agent-session-journal/journal-store-factory'
import { journalIdentityFor } from './structured-agent-session-attach'
import { attachParamsForRecord } from './structured-agent-session-conversation-open'
import { StructuredAgentSessionConversations } from './structured-agent-session-conversations'
import { createStructuredAgentSessionConversationLifetime } from './structured-agent-session-conversation-lifetime'
import type { StructuredAgentSessionLifetimeContext } from './structured-agent-session-host-lifetime'
import { createStructuredAgentSessionRestartOfferWithdrawal } from './structured-agent-session-restart-offer-withdrawal'
import { restoreStructuredAgentSessionsOnRestart } from './structured-agent-session-restart-restore'
import { createStructuredAgentSessionLogger } from './structured-agent-session-logger'
import { recordingStructuredAgentSessionLogger } from './structured-agent-session-logger-test-support'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'

const { readOnlyOpens, openReadOnly } = vi.hoisted(() => ({
  readOnlyOpens: new Array<string>(),
  openReadOnly: new Set<object>()
}))

// Every read-only open is of a per-chat file: the host's own database opens read-write.
vi.mock('../../sqlite/sync-database', async (importOriginal) => {
  const actual = await importOriginal<typeof SyncDatabaseModule>()
  class RecordingDatabase extends actual.default {
    constructor(...args: ConstructorParameters<typeof actual.default>) {
      super(...args)
      if (args[1]?.readonly) {
        readOnlyOpens.push(String(args[0]))
        openReadOnly.add(this)
      }
    }

    override close(): void {
      openReadOnly.delete(this)
      super.close()
    }
  }
  return { ...actual, default: RecordingDatabase }
})

const WORKSPACE_ID = 'repo-1::/tmp/workspace'
const PROMPT = 'add a retry'

let root: string
let clock = 1_000

function recordFor(sessionId: string): AgentSessionRecord {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: restore reads only the id, location, provider, handle chain, account home and lease.
  return {
    schemaVersion: 2,
    sessionId,
    location: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: WORKSPACE_ID,
      workspaceKind: 'git-worktree'
    },
    provider: 'codex',
    providerHandleChain: [
      {
        linkId: `codex-1-${sessionId}`,
        handle: codexProviderHandle(`thread-${sessionId}`),
        origin: 'created',
        mintedAtFence: 1,
        observedAt: 1
      }
    ],
    accountHome: { variable: 'CODEX_HOME', path: '/tmp/codex-home' },
    createdAt: 1,
    updatedAt: 2,
    lease: { sessionId, runtimeKind: 'native', runtimeFence: 1 }
  } as unknown as AgentSessionRecord
}

function identityFor(sessionId: string) {
  const record = recordFor(sessionId)
  return journalIdentityFor(
    record,
    attachParamsForRecord(record, { clientOperationId: 'seed', expectedRuntimeFence: 1 })
  )
}

function legacyDirFor(sessionId: string): string {
  return journalDirectoryFor(root, { workspaceId: WORKSPACE_ID, sessionId })
}

/** What the run before the upgrade left open in a chat, for its restore to settle. */
type MidWork = 'running tool call' | 'unresolved send'

/** A chat as an earlier build left it: real rows in its own per-chat file, nothing in the host's. */
async function seedLegacyChat(
  sessionId: string,
  replies = 1,
  midWork?: MidWork
): Promise<JournalStoredRow[]> {
  const scratch = join(root, `scratch-${sessionId}`)
  const identity = identityFor(sessionId)
  const journal = await openAgentSessionJournal({
    identity,
    database: openTestJournalHostDatabase(scratch),
    now: () => (clock += 1)
  })
  await journal.appendSubmission({
    clientMessageId: `client-${sessionId}`,
    payloadFingerprint: 'fp-1',
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: PROMPT }] },
    fence: 1,
    handoverRecorded: true
  })
  if (midWork === 'running tool call') {
    await journal.appendItem(
      { provider: 'codex', threadId: `thread-${sessionId}`, turnId: 't', ordinal: 50 },
      { kind: 'tool-call', name: 'Read', input: {}, state: 'running' },
      { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
  }
  await journal.resolveDispatch(
    midWork === 'unresolved send'
      ? // Handed over, and never answered.
        {
          clientMessageId: `client-${sessionId}`,
          fence: 1,
          state: 'pending',
          turnScope: AGENT_JOURNAL_THREAD_SCOPE
        }
      : {
          clientMessageId: `client-${sessionId}`,
          fence: 1,
          state: 'accepted',
          providerIdentity: {
            provider: 'codex',
            threadId: `thread-${sessionId}`,
            turnId: 't',
            ordinal: 0
          }
        }
  )
  for (let ordinal = 1; ordinal <= replies; ordinal += 1) {
    await journal.appendItem(
      { provider: 'codex', threadId: `thread-${sessionId}`, turnId: 't', ordinal },
      { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: `reply ${ordinal}` }] },
      { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
  }
  await journal.close()
  const rows = readTestJournalRows(
    openTestJournalHostDatabase(scratch).db,
    sessionId,
    journal.epoch
  )
  const path = legacyJournalDatabaseFile(legacyDirFor(sessionId))
  await mkdir(dirname(path), { recursive: true })
  const db = new Database(path)
  try {
    db.pragma('journal_mode = WAL')
    db.exec(`
CREATE TABLE journal_rows (session_id TEXT NOT NULL, epoch TEXT NOT NULL, seq INTEGER NOT NULL,
  ts INTEGER NOT NULL, row_json TEXT NOT NULL, PRIMARY KEY (session_id, epoch, seq));
CREATE TABLE journal_sessions (session_id TEXT PRIMARY KEY, epoch TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE journal_repairs (session_id TEXT PRIMARY KEY, epoch TEXT NOT NULL,
  content_from INTEGER NOT NULL, repaired_at INTEGER NOT NULL);`)
    db.pragma('user_version = 2')
    const insert = db.prepare(
      'INSERT INTO journal_rows (session_id, epoch, seq, ts, row_json) VALUES (?, ?, ?, ?, ?)'
    )
    for (const row of rows) {
      insert.run(sessionId, row.epoch, row.seq, row.ts, row.rowJson)
    }
    db.prepare('INSERT INTO journal_sessions VALUES (?, ?, ?)').run(sessionId, rows[0]!.epoch, 1)
  } finally {
    db.close()
  }
  return rows
}

function legacyFile(sessionId: string): string {
  return legacyJournalDatabaseFile(legacyDirFor(sessionId))
}

function hostDb(): Database.Database {
  return openTestJournalHostDatabase(root).db
}

function importCount(): number {
  return Number(hostDb().prepare('SELECT count(*) AS n FROM journal_imports').get()?.n)
}

type LifetimeHost = Parameters<typeof createStructuredAgentSessionConversationLifetime>[0]

function conversations(): StructuredAgentSessionConversations {
  return new StructuredAgentSessionConversations({
    deliver: () => undefined,
    logger: recordingStructuredAgentSessionLogger().logger,
    now: () => clock
  })
}

async function restore(sessionIds: readonly string[]) {
  const sessions = conversations()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: restore and an open conversation's read touch only `getRecord` and `listRecords`.
  const store = {
    getRecord: (sessionId: string) => recordFor(sessionId),
    listRecords: () => sessionIds.map(recordFor)
  } as unknown as AgentSessionRecordStore
  const log = recordingStructuredAgentSessionLogger()
  const deps = {
    store,
    adapter: {},
    journalDatabase: openTestJournalHostDatabase(root),
    logger: log.logger
  }
  await restoreStructuredAgentSessionsOnRestart({
    openDeps: deps,
    records: sessionIds.map(recordFor),
    reconcile: async () => true,
    resolveRecovery: async () => true,
    serialize: async (_sessionId, task) => task(),
    hasSession: (sessionId) => sessions.has(sessionId),
    onReadable: (sessionId, opened) => {
      sessions.set(sessionId, opened.session)
    }
  })
  const context = (): StructuredAgentSessionLifetimeContext =>
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: reaching an open conversation reads only `deps.store` and `deps.adapter`.
    ({ deps, now: () => clock }) as unknown as StructuredAgentSessionLifetimeContext
  const lifetimeOver = (listed: LifetimeHost['sessions'], open: LifetimeHost['open']) =>
    createStructuredAgentSessionConversationLifetime({
      context,
      sessions: listed,
      serialize: async (_sessionId, task) => task(),
      open,
      deliveryActive: () => false,
      closeStatus: () => undefined,
      readChildWork: () => undefined
    })
  const lifetime = lifetimeOver(sessions, async (sessionId) => sessions.get(sessionId) ?? null)
  return { sessions, lifetime, lifetimeOver, log }
}

function texts(items: readonly { body: unknown }[]): string {
  return JSON.stringify(items.map((entry) => entry.body))
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-restore-without-import-'))
  clock = 1_000
  readOnlyOpens.length = 0
})

afterEach(async () => {
  vi.restoreAllMocks()
  closeTestJournalHostDatabases()
  await rm(root, { recursive: true, force: true })
})

describe('startup restore of chats still in their per-chat files', () => {
  it('lists every restored chat without copying one, and opens only their files', async () => {
    const restored = ['chat-a', 'chat-b', 'chat-c']
    const rows = new Map<string, JournalStoredRow[]>()
    for (const sessionId of [...restored, 'chat-closed']) {
      rows.set(sessionId, await seedLegacyChat(sessionId))
    }
    readOnlyOpens.length = 0
    const before = new Map(
      await Promise.all(
        restored.map(
          async (sessionId) => [sessionId, await readFile(legacyFile(sessionId))] as const
        )
      )
    )

    const { sessions } = await restore(restored)

    // Each file was closed by the fold that read it, so nothing holds it open for a later rename.
    expect(openReadOnly.size).toBe(0)
    // Read, never written: the same bytes, in the same place, beside only SQLite's own WAL files.
    for (const sessionId of restored) {
      expect((await readFile(legacyFile(sessionId))).equals(before.get(sessionId)!)).toBe(true)
      const entries = await readdir(legacyDirFor(sessionId))
      expect(entries.filter((name) => !/^journal\.db(-wal|-shm)?$/.test(name))).toEqual([])
    }

    expect([...sessions.keys()].sort()).toEqual(restored)
    for (const sessionId of restored) {
      const journal = sessions.get(sessionId)!.journal
      expect(journal.cursor().sequence).toBe(rows.get(sessionId)!.length)
      expect(texts(journal.snapshot().items)).toContain('reply 1')
      expect(readJournalSessionEpoch(hostDb(), sessionId)).toBeNull()
      expect(existsSync(legacyJournalDatabaseFile(legacyDirFor(sessionId)))).toBe(true)
    }
    for (const sessionId of restored) {
      await sessions.get(sessionId)!.journal.close()
    }
    expect(importCount()).toBe(0)
    // One read of each restored chat's file, and none of the chat that was not restored.
    expect(readOnlyOpens.sort()).toEqual(
      restored.map((sessionId) => legacyJournalDatabaseFile(legacyDirFor(sessionId))).sort()
    )
  })

  // Restore copies a chat only to write to it itself, settling what the last run left open (a
  // turn, tool call, approval, question, send or subagent). A settled chat is never copied here.
  it.each(['running tool call', 'unresolved send'] as const)(
    'copies during restore only a chat it settles (%s)',
    async (midWork) => {
      const rows = await seedLegacyChat('chat-mid-work', 1, midWork)
      await seedLegacyChat('chat-settled')

      const { sessions } = await restore(['chat-mid-work', 'chat-settled'])

      // Restore wrote a settlement to the chat left mid-work, so it copied that chat first.
      const settled = sessions.get('chat-mid-work')!.journal
      expect(settled.cursor().sequence).toBeGreaterThan(rows.length)
      expect(
        readTestJournalRows(hostDb(), 'chat-mid-work', rows[0]!.epoch).slice(0, rows.length)
      ).toEqual(rows)
      expect(existsSync(legacyFile('chat-mid-work'))).toBe(false)
      expect(readJournalSessionEpoch(hostDb(), 'chat-settled')).toBeNull()
      expect(existsSync(legacyFile('chat-settled'))).toBe(true)
      expect(importCount()).toBe(1)
    }
  )

  it('lets other work run while it reads a large per-chat file', async () => {
    // Past one batch of the file's rows.
    const rows = await seedLegacyChat('chat-a', 520)
    let turns = 0
    let ticking = true
    const tick = (): void => {
      turns += 1
      if (ticking) {
        setImmediate(tick)
      }
    }

    setImmediate(tick)
    const folded = await previewPerSessionJournal({
      database: openTestJournalHostDatabase(root),
      identity: identityFor('chat-a'),
      legacyDirectory: legacyDirFor('chat-a')
    })
    ticking = false

    expect(turns).toBeGreaterThan(0)
    expect(folded?.state.lastSequence).toBe(rows.length)
    expect(openReadOnly.size).toBe(0)
  })

  // T-B3 for a chat restore did not copy: the offer taken before the upgrade still stands.
  it('offers the restorable turn of a chat it did not copy', async () => {
    const rows = await seedLegacyChat('chat-a')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: `movedOn` reads only the session id and the journal cursor.
    const marker = {
      sessionId: 'chat-a',
      journalCursor: { epoch: rows[0]!.epoch, sequence: rows.length }
    } as AgentSessionResumeMarker

    const { sessions } = await restore(['chat-a'])
    const withdrawal = createStructuredAgentSessionRestartOfferWithdrawal({
      logger: createStructuredAgentSessionLogger(),
      sessions,
      now: () => clock,
      enqueue: (operation) => operation()
    })

    expect(withdrawal.movedOn(marker)).toBe(false)
    expect(
      latestStructuredAgentSessionPrompt(sessions.get('chat-a')!.journal.snapshot().items)
    ).toBe(PROMPT)
    expect(importCount()).toBe(0)
  })

  it('copies a chat on its first read, and serves its history verbatim', async () => {
    const rows = await seedLegacyChat('chat-a')
    const { lifetime, sessions } = await restore(['chat-a'])
    const listed = sessions.get('chat-a')!.journal.snapshot()

    const journal = (await lifetime.conversation('chat-a')).journal
    const since = journal.readSince({ epoch: rows[0]!.epoch, sequence: 0 })

    // The copied chat is the chat restore listed, item for item.
    expect(journal.snapshot()).toEqual(listed)

    expect(importCount()).toBe(1)
    expect(readTestJournalRows(hostDb(), 'chat-a', rows[0]!.epoch)).toEqual(rows)
    expect(since.ok && since.rows.map((row) => row.seq)).toEqual(rows.map((row) => row.seq))
    expect(existsSync(legacyDirFor('chat-a'))).toBe(false)
  })

  // A read queued behind restore's open of the same chat reaches it through its own open, not the
  // listing: it still waits for the copy, and reads the chat from the one database.
  it('makes a read whose open lands on the chat restore opened wait for its copy', async () => {
    const rows = await seedLegacyChat('chat-a')
    const { sessions, lifetimeOver } = await restore(['chat-a'])
    const restored = sessions.get('chat-a')!
    const lifetime = lifetimeOver(conversations(), async () => restored)

    const { journal } = await lifetime.conversation('chat-a')
    const since = journal.readSince({ epoch: rows[0]!.epoch, sequence: 0 })

    expect(importCount()).toBe(1)
    expect(since.ok && since.rows.map((row) => row.seq)).toEqual(rows.map((row) => row.seq))
  })

  // Whether the read finds the chat restore listed, or opens it and lands on the one restore opened.
  it.each(['listed', 'opened'] as const)(
    'refuses a read of the chat restore %s when its copy meets damage, never with the storage text',
    async (reach) => {
      await seedLegacyChat('chat-a')
      const { sessions, lifetime, lifetimeOver, log } = await restore(['chat-a'])
      const restored = sessions.get('chat-a')!
      await rm(legacyDirFor('chat-a'), { recursive: true, force: true })
      await mkdir(legacyDirFor('chat-a'), { recursive: true })
      await writeFile(legacyFile('chat-a'), 'not a database, and never was one')
      const reader =
        reach === 'listed' ? lifetime : lifetimeOver(conversations(), async () => restored)

      const read = reader.conversation('chat-a')

      await expect(read).rejects.toBeInstanceOf(AgentSessionRefusalError)
      await expect(read).rejects.toMatchObject({
        message: 'agent_session_journal_unreadable',
        refusal: { details: { reason: 'journalCorrupt' } }
      })
      // The storage text the reader never sees goes to the host's log.
      expect(log.entries.filter((entry) => entry.fields.scope === 'open-for-read')).toEqual([
        expect.objectContaining({
          fields: { scope: 'open-for-read', sessionId: 'chat-a', error: expect.any(Error) }
        })
      ])
    }
  )

  it('copies a chat before its first write, and the write lands after its history', async () => {
    const rows = await seedLegacyChat('chat-a')
    const { sessions } = await restore(['chat-a'])
    const journal = sessions.get('chat-a')!.journal

    await journal.appendItem(
      { provider: 'codex', threadId: 'thread-chat-a', turnId: 't', ordinal: 9 },
      { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'after' }] },
      { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )

    const stored = readTestJournalRows(hostDb(), 'chat-a', rows[0]!.epoch)
    expect(stored.slice(0, rows.length)).toEqual(rows)
    expect(stored).toHaveLength(rows.length + 1)
    expect(importCount()).toBe(1)
  })

  it("copies a chat before a Stop's event, which lands before the turn's end and the kill after it", async () => {
    const rows = await seedLegacyChat('chat-a')
    const { sessions } = await restore(['chat-a'])
    const journal = sessions.get('chat-a')!.journal
    expect(journal.importPending).toBe(true)
    const scope = { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }

    // In the Stop's order: its event, then the stopped turn's end, then a row the kill writes.
    const [stopped, ended, killed] = await Promise.all([
      journal.appendStopEvent({ reason: 'user-stop' }, 1),
      journal.appendItem(
        { provider: 'codex', threadId: 'thread-chat-a', turnId: 't', ordinal: 9 },
        { kind: 'turn', turnId: 't', state: 'interrupted', startedAt: 1 },
        scope
      ),
      journal.appendItem(
        { provider: 'codex', threadId: 'thread-chat-a', turnId: 't', ordinal: 10 },
        { kind: 'status', text: 'the agent ended' },
        scope
      )
    ])

    expect(readTestJournalRows(hostDb(), 'chat-a', rows[0]!.epoch).slice(0, rows.length)).toEqual(
      rows
    )
    expect([stopped.sequence, ended.cursor.sequence, killed.cursor.sequence]).toEqual([
      rows.length + 1,
      rows.length + 2,
      rows.length + 3
    ])
  })

  it("copies a chat before its first queued message, which lands as that chat's draft", async () => {
    const rows = await seedLegacyChat('chat-a')
    const { sessions } = await restore(['chat-a'])
    const journal = sessions.get('chat-a')!.journal
    expect(journal.importPending).toBe(true)

    await journal.queuedMessages.insert({
      messageId: 'draft-1',
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'later' }] },
      fingerprint: 'fp-draft-1',
      hostInstance: 'proc-1'
    })

    expect(journal.importPending).toBe(false)
    expect(readTestJournalRows(hostDb(), 'chat-a', rows[0]!.epoch)).toEqual(rows)
    expect(existsSync(legacyFile('chat-a'))).toBe(false)
    expect(importCount()).toBe(1)
    expect(journal.queuedMessages.list()).toMatchObject([
      { messageId: 'draft-1', state: 'waiting' }
    ])
  })

  it('never shows a read racing the copy a partly copied chat', async () => {
    // Past one import batch, so the copy yields to other work between batches.
    const rows = await seedLegacyChat('chat-a', 520)
    const { lifetime, sessions } = await restore(['chat-a'])
    const journal = sessions.get('chat-a')!.journal
    const cursor = { epoch: rows[0]!.epoch, sequence: 0 }
    const seen: { published: boolean; copied: number; folded: number }[] = []
    const reads: Promise<number>[] = []
    let ticking = true
    const tick = (): void => {
      seen.push({
        published: readJournalSessionEpoch(hostDb(), 'chat-a') !== null,
        copied: Number(hostDb().prepare('SELECT count(*) AS n FROM journal_rows').get()?.n),
        folded: journal.cursor().sequence
      })
      reads.push(
        lifetime.conversation('chat-a').then(({ journal: read }) => {
          const since = read.readSince(cursor)
          return since.ok ? since.rows.length : -1
        })
      )
      if (ticking) {
        setImmediate(tick)
      }
    }
    setImmediate(tick)

    await lifetime.conversation('chat-a')
    ticking = false
    await new Promise((resolve) => setImmediate(resolve))

    // The copy was under way while other work ran, and none of it saw part of the chat.
    expect(seen.some((turn) => !turn.published && turn.copied > 0)).toBe(true)
    expect(seen.every((turn) => !turn.published || turn.copied === rows.length)).toBe(true)
    expect(seen.every((turn) => turn.folded === rows.length)).toBe(true)
    expect(new Set(await Promise.all(reads))).toEqual(new Set([rows.length]))
  })
})
