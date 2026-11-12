import {
  ensureStructuredAgentSessionHost,
  stopStructuredAgentSessionRuntime
} from '../structured-agent-session-runtime'
import { openAgentSessionRecordStoreOnce } from '../records/agent-session-record-store-slot'
import {
  journalSqlReaderPath,
  journalSqlWorkerPath
} from '../../../native-chat/agent-session-journal/journal-sql-worker-bundle.test-fixture'
import { recordingStructuredAgentSessionLogger } from '../../../native-chat/agent-session-wire/host/testing/structured-agent-session-logger.test-fixture'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { foundAgentSessionRecord } from '../records/agent-session-record-founding'
import {
  openTestAgentSessionRecordStore,
  seedTestAgentSessionRecordStore,
  closeTestAgentSessionRecordStores,
  withTestAgentSessionDatabase
} from '../records/agent-session-record-store-test-harness'

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-permission-backfill-'))
})
afterEach(async () => {
  await stopStructuredAgentSessionRuntime()
  vi.restoreAllMocks()
  await closeTestAgentSessionRecordStores()
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
    await withTestAgentSessionDatabase(root, (db) =>
      db.exec(
        "CREATE TRIGGER refuse_backfill_write BEFORE UPDATE ON agent_session_records WHEN NEW.session_id = 'session-codex' BEGIN SELECT RAISE(ABORT, 'disk full'); END"
      )
    )
    await expect(store.backfillChatPermissionModes(() => true)).rejects.toThrow('disk full')
    expect(store.listRecords().every((row) => row.permissionMode === undefined)).toBe(true)
    expect(
      (await openTestAgentSessionRecordStore(root, { mode: 'observe' }))
        .listRecords()
        .every((row) => row.permissionMode === undefined)
    ).toBe(true)
    await withTestAgentSessionDatabase(root, (db) => db.exec('DROP TRIGGER refuse_backfill_write'))
    await store.backfillChatPermissionModes(() => true)
    expect(store.listRecords().every((row) => row.permissionMode === 'full-access')).toBe(true)
  })
})

it('keeps startup and option reads available when the SQL permission backfill fails', async () => {
  await seedTestAgentSessionRecordStore(root, { records: [record('codex')] })
  await withTestAgentSessionDatabase(root, (db) =>
    db.exec(`CREATE TRIGGER fail_permission_backfill BEFORE UPDATE ON agent_session_records
      WHEN json_extract(NEW.record_json,'$.permissionMode') IS NOT json_extract(OLD.record_json,'$.permissionMode')
      BEGIN SELECT RAISE(ABORT, 'disk full'); END`)
  )
  const logged = recordingStructuredAgentSessionLogger()
  await openAgentSessionRecordStoreOnce({
    stateDirectory: root,
    hostId: 'local',
    logger: logged.logger,
    legacySessionTabIds: [],
    writerPath: journalSqlWorkerPath(),
    readerPath: journalSqlReaderPath()
  })
  const host = await ensureStructuredAgentSessionHost({
    logger: logged.logger,
    stateDirectory: root,
    hostId: 'local',
    claimKeyId: 'key-1',
    resolveWorkspacePath: async () => root,
    resolveLaunchArgs: () => [],
    resolveClaudeAuthPolicy: () => ({ account: 'managed' }),
    resolveAgentFullAccess: () => true,
    resolveEnvironment: async () => ({})
  })
  expect(host.deps.store.getRecord('session-codex')?.permissionMode).toBeUndefined()
  expect((await host.readOptions('session-codex')).current.permissionMode).toBe('ask')
  expect(logged.scopes()).toContain('permission-mode-backfill')
})
