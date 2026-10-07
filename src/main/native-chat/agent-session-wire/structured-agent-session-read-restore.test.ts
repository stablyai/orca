// Read restore decides whether a session comes back at all: only one with a record and a journal
// to read is published, and publishing it starts no agent.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import {
  closeTestJournalHostDatabases,
  openTestJournalHostDatabase
} from '../agent-session-journal/journal-host-database-test-support'
import { publishJournalSessionEpoch } from '../agent-session-journal/journal-row-table'
import { restoreStructuredAgentSessionRead } from './structured-agent-session-read-restore'
import { recordingStructuredAgentSessionLogger } from './structured-agent-session-logger-test-support'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'

const SESSION_ID = 'codex_read_restore_fixture'
const WORKSPACE_ID = 'repo-1::/tmp/workspace'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a literal record the read path only reads; its fields match the record shape.
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
      handle: codexProviderHandle('thread-1'),
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

const store = {
  getRecord: (sessionId: string) => (sessionId === SESSION_ID ? RECORD : null)
} as unknown as AgentSessionRecordStore

let journalRoot: string
const openDeps = () => ({
  store,
  journalDatabase: openTestJournalHostDatabase(journalRoot),
  logger: recordingStructuredAgentSessionLogger().logger
})
const opened: AgentSessionJournal[] = []

beforeEach(async () => {
  journalRoot = await mkdtemp(join(tmpdir(), 'orca-read-restore-'))
})

afterEach(async () => {
  await Promise.allSettled(opened.splice(0).map((journal) => journal.close()))
  closeTestJournalHostDatabases()
  await rm(journalRoot, { recursive: true, force: true })
})

describe('read restore', () => {
  it('publishes a session with a journal, starting no agent', async () => {
    const deps = openDeps()
    const restored = await restoreStructuredAgentSessionRead(deps, SESSION_ID)
    expect(restored).toBeNull()
    publishJournalSessionEpoch(
      deps.journalDatabase.db,
      { sessionId: SESSION_ID, workspaceId: WORKSPACE_ID },
      'epoch-1'
    )

    const published = await restoreStructuredAgentSessionRead(deps, SESSION_ID)

    expect(published).not.toBeNull()
    opened.push(published!.session.journal)
    expect(published!.session.child).toBeNull()
  })

  it('drops a session with no journal', async () => {
    const restored = await restoreStructuredAgentSessionRead(openDeps(), SESSION_ID)

    expect(restored).toBeNull()
  })

  it('drops a session with no record', async () => {
    const restored = await restoreStructuredAgentSessionRead(openDeps(), 'unknown-session')

    expect(restored).toBeNull()
  })
})
