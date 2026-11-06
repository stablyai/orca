import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { foundAgentSessionRecord } from '../records/agent-session-record-founding'
import {
  openTestAgentSessionRecordStore,
  seedTestAgentSessionRecordStore
} from '../records/agent-session-record-store-test-harness'
import {
  closeTestJournalHostDatabases,
  openTestJournalHostDatabase
} from '../../../native-chat/agent-session-journal/store-lifecycle/journal-host-database-test-support'

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-permission-backfill-'))
})
afterEach(async () => {
  await closeTestJournalHostDatabases()
  await rm(root, { recursive: true, force: true })
})

function record(provider: string, options?: Record<string, string>) {
  return foundAgentSessionRecord(
    {
      sessionId: `session-${provider}`,
      provider,
      location: {
        executionHostId: 'local',
        workspaceId: 'folder-1',
        workspaceKind: 'folder',
        wslDistro: null
      },
      accountHome: {
        variable: provider === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME',
        path: '/account'
      },
      ...(options ? { options } : {})
    },
    { claimKeyId: 'key-1', now: 1 }
  )
}

describe('existing chat permission backfill', () => {
  it('rolls back every row if saving fails, then succeeds on the next startup pass', async () => {
    await seedTestAgentSessionRecordStore(root, { records: [record('claude'), record('codex')] })
    const store = await openTestAgentSessionRecordStore(root)
    const db = openTestJournalHostDatabase(root).db
    db.exec(
      "CREATE TRIGGER refuse_backfill_write BEFORE UPDATE ON agent_session_records WHEN NEW.session_id = 'session-codex' BEGIN SELECT RAISE(ABORT, 'disk full'); END"
    )
    await expect(store.backfillChatPermissionModes(() => true)).rejects.toThrow('disk full')
    expect(store.listRecords().every((row) => row.permissionMode === undefined)).toBe(true)
    expect(
      (await openTestAgentSessionRecordStore(root))
        .listRecords()
        .every((row) => row.permissionMode === undefined)
    ).toBe(true)
    db.exec('DROP TRIGGER refuse_backfill_write')
    await store.backfillChatPermissionModes(() => true)
    expect(store.listRecords().every((row) => row.permissionMode === 'full-access')).toBe(true)
  })
})
