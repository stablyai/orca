// Read restore decides whether a session comes back at all.
//
// A chat still in the pre-SQLite format has no `journal.db`, so the probe that
// loads one reports nothing. Reading that as "no session" is what removed these
// chats: an unpublished session is also what prunes its tab out of the saved
// workspace, so the tab is gone before anything can explain itself. A record
// whose journal is simply GONE reads identically to the probe and is the same
// disappearance, so it comes back too — carrying the anchor that says its
// history is still owed rather than a blank epoch that claims it had none.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { loadJournal } from '../agent-session-journal/journal-open'
import { journalDirectoryFor } from '../agent-session-journal/journal-paths'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { restoreStructuredAgentSessionRead } from './structured-agent-session-read-restore'

const SESSION_ID = 'codex_read_restore_fixture'
const WORKSPACE_ID = 'repo-1::/tmp/workspace'

const RECORD = {
  schemaVersion: 2,
  sessionId: SESSION_ID,
  location: {
    executionHostId: 'local',
    wslDistro: null,
    workspaceId: WORKSPACE_ID,
    workspaceKind: 'git-worktree'
  },
  provider: 'codex',
  providerHandleChain: [
    {
      linkId: 'codex-1-thread-1',
      handle: { provider: 'codex', threadId: 'thread-1' },
      origin: 'created',
      mintedAtFence: 1,
      observedAt: 1
    }
  ],
  accountHome: { variable: 'CODEX_HOME', path: '/tmp/codex-home' },
  createdAt: 1,
  updatedAt: 2,
  lease: { sessionId: SESSION_ID, runtimeKind: 'native', runtimeFence: 1 }
} as unknown as AgentSessionRecord

/** The same record before any provider proved a handle for it: no conversation
 *  is named, so there is no history a rebuild could ask for. */
const RECORD_WITHOUT_CONVERSATION = {
  ...RECORD,
  providerHandleChain: []
} as unknown as AgentSessionRecord

const store = {
  getRecord: (sessionId: string) => (sessionId === SESSION_ID ? RECORD : null)
} as unknown as AgentSessionRecordStore

const storeWithoutConversation = {
  getRecord: (sessionId: string) => (sessionId === SESSION_ID ? RECORD_WITHOUT_CONVERSATION : null)
} as unknown as AgentSessionRecordStore

let journalRoot: string
const opened: AgentSessionJournal[] = []

async function writeRemnant(name: string): Promise<string> {
  const dir = journalDirectoryFor(journalRoot, {
    workspaceId: WORKSPACE_ID,
    sessionId: SESSION_ID
  })
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, name), '{"kind":"epoch","v":1,"seq":1}\n', 'utf8')
  return join(dir, name)
}

beforeEach(async () => {
  journalRoot = await mkdtemp(join(tmpdir(), 'orca-read-restore-'))
  // Recovery discovers the provider transcript by session id; point both roots
  // at the empty temp tree so the search stays inside the fixture.
  vi.stubEnv('ORCA_USER_DATA_PATH', journalRoot)
  vi.stubEnv('CODEX_HOME', journalRoot)
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.allSettled(opened.splice(0).map((journal) => journal.close()))
  await rm(journalRoot, { recursive: true, force: true })
})

describe('a session whose journal is still the pre-SQLite format', () => {
  it('is published, carrying the message that explains it', async () => {
    const transcript = await writeRemnant('log.jsonl')

    const restored = await restoreStructuredAgentSessionRead(store, journalRoot, SESSION_ID)

    expect(restored).not.toBeNull()
    opened.push(restored!.journal)
    const disclosed = restored!.journal
      .snapshot()
      .items.map((entry) => (entry.body.kind === 'status' ? entry.body.text : ''))
    expect(disclosed.join('')).toContain(transcript)
    // Publishing it costs no agent process; acquisition still waits for the user.
    expect(restored!.hasProviderChild).toBe(false)
  })

  it('is published for a remnant whose log is gone', async () => {
    await writeRemnant('snapshot.json')

    const restored = await restoreStructuredAgentSessionRead(store, journalRoot, SESSION_ID)

    expect(restored).not.toBeNull()
    opened.push(restored!.journal)
  })

  it('still drops a session with no record', async () => {
    await writeRemnant('log.jsonl')

    const restored = await restoreStructuredAgentSessionRead(store, journalRoot, 'unknown-session')

    expect(restored).toBeNull()
  })
})

describe('a record whose journal is gone', () => {
  it('comes back owed a rebuild rather than being dropped', async () => {
    const restored = await restoreStructuredAgentSessionRead(store, journalRoot, SESSION_ID)

    expect(restored).not.toBeNull()
    opened.push(restored!.journal)
    // Nothing was imported — no transcript exists — so what must NOT be here is
    // a blank epoch standing in as the session's own history.
    expect(restored!.journal.snapshot().items).toEqual([])
    await restored!.journal.close()
    const journalDir = journalDirectoryFor(journalRoot, {
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID
    })
    expect(loadJournal(journalDir, SESSION_ID)).toMatchObject({
      corrupt: true,
      historyMissing: true
    })
  })

  it('is still dropped when the record names no provider conversation', async () => {
    const restored = await restoreStructuredAgentSessionRead(
      storeWithoutConversation,
      journalRoot,
      SESSION_ID
    )

    expect(restored).toBeNull()
  })
})
