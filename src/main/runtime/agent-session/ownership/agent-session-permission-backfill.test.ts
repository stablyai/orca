import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { codexProviderHandle } from '../../../../shared/agent-session-provider-handle-encoding'
import { foundAgentSessionRecord } from '../../agent-session-record-founding'
import {
  openTestAgentSessionRecordStore,
  seedTestAgentSessionRecordStore,
  seedTestAgentSessionStoreFromNewerBuild
} from '../../agent-session-record-store-test-harness'
import {
  closeTestJournalHostDatabases,
  openTestJournalHostDatabase
} from '../../../native-chat/agent-session-journal/journal-host-database-test-support'

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
  it.each(['full-access', 'ask'] as const)(
    "saves %s from the agent's own Arguments for old Claude and Codex rows, keeping other options",
    async (mode) => {
      await seedTestAgentSessionRecordStore(root, {
        records: [record('claude', { model: 'opus', effort: 'high' }), record('codex')]
      })
      const store = await openTestAgentSessionRecordStore(root)
      const beforeClaude = store.getRecord('session-claude')
      const beforeCodex = store.getRecord('session-codex')
      await store.backfillChatPermissionModes(() => mode === 'full-access')
      expect(store.getRecord('session-claude')).toEqual({ ...beforeClaude, permissionMode: mode })
      expect(store.getRecord('session-codex')).toEqual({ ...beforeCodex, permissionMode: mode })
      const reopened = await openTestAgentSessionRecordStore(root)
      expect(reopened.getRecord('session-claude')?.permissionMode).toBe(mode)
      expect(reopened.getRecord('session-codex')?.permissionMode).toBe(mode)
    }
  )

  it.each(['ask', 'full-access', 'invalid-saved-mode'] as const)(
    'never replaces saved %s, even one an earlier build saved among the options',
    async (mode) => {
      // The codex row is what an hourly build before the field wrote.
      const earlier = { ...record('codex'), options: { model: 'gpt', permissionMode: mode } }
      await seedTestAgentSessionRecordStore(root, {
        records: [
          record('claude', { permissionMode: mode }),
          earlier,
          record('pi', { model: 'pi' })
        ]
      })
      const store = await openTestAgentSessionRecordStore(root)
      const [claude, codex, pi] = ['claude', 'codex', 'pi'].map((provider) =>
        store.getRecord(`session-${provider}`)
      )
      await store.backfillChatPermissionModes(() => mode !== 'full-access')
      expect(store.getRecord('session-claude')).toEqual(claude)
      expect(store.getRecord('session-codex')).toEqual({
        ...codex,
        options: { model: 'gpt' },
        permissionMode: mode
      })
      expect(store.getRecord('session-pi')).toEqual(pi)
    }
  )

  it('does no row write on its second pass, even with changed Arguments', async () => {
    await seedTestAgentSessionRecordStore(root, { records: [record('claude'), record('codex')] })
    const store = await openTestAgentSessionRecordStore(root)
    await store.backfillChatPermissionModes(() => true)
    const before = store.listRecords()
    const db = openTestJournalHostDatabase(root).db
    db.exec(
      "CREATE TRIGGER refuse_backfill_write BEFORE UPDATE ON agent_session_records BEGIN SELECT RAISE(ABORT, 'unexpected second write'); END"
    )
    await expect(store.backfillChatPermissionModes(() => false)).resolves.toBeUndefined()
    expect(store.listRecords()).toEqual(before)
    expect(store.getRecord('session-claude')).toBe(before.find((row) => row.provider === 'claude'))
    expect(store.getRecord('session-codex')?.permissionMode).toBe('full-access')
  })

  it('skips a store written by a newer build without an error or in-memory change', async () => {
    await seedTestAgentSessionRecordStore(root, { records: [record('claude')] })
    await seedTestAgentSessionStoreFromNewerBuild(root)
    const store = await openTestAgentSessionRecordStore(root)
    expect(store.readOnly).toBe(true)
    expect(store.getRecord('session-claude')).not.toBeNull()
    await expect(store.backfillChatPermissionModes(() => true)).resolves.toBeUndefined()
    expect(store.getRecord('session-claude')?.permissionMode).toBeUndefined()
  })

  it.each([
    ['claude', 'full-access', 'ask', 'ask'],
    ['codex', 'ask', 'full-access', 'ask'],
    ['omp', 'ask', 'ask', 'full-access']
  ] as const)(
    'fills each row from what its own agent ran with when only %s skips prompts',
    async (bypassing, claude, codex, omp) => {
      await seedTestAgentSessionRecordStore(root, {
        records: [record('claude'), record('codex'), record('omp'), record('pi')]
      })
      const store = await openTestAgentSessionRecordStore(root)
      await store.backfillChatPermissionModes((provider) => provider === bypassing)
      expect(store.getRecord('session-claude')?.permissionMode).toBe(claude)
      expect(store.getRecord('session-codex')?.permissionMode).toBe(codex)
      expect(store.getRecord('session-omp')?.permissionMode).toBe(omp)
      expect(store.getRecord('session-pi')?.permissionMode).toBeUndefined()
    }
  )

  it('preserves the existing owner identity, fence, timestamps and provider history', async () => {
    const old = record('codex', { model: 'old-model', effort: 'high' })
    await seedTestAgentSessionRecordStore(root, {
      records: [
        {
          ...old,
          lease: {
            ...old.lease,
            runtimeFence: 7,
            claimStatus: 'reserved',
            handoffStage: 'new-owner-proving',
            reservedSpawnToken: 'old-spawn',
            ownerProcess: {
              hostId: 'local',
              pid: 42,
              processStartTimeMs: 1,
              spawnToken: 'old-spawn'
            }
          },
          providerHandleChain: [
            {
              linkId: 'old-link',
              handle: codexProviderHandle('old-thread'),
              origin: 'created',
              mintedAtFence: 6,
              observedAt: 1
            }
          ]
        }
      ]
    })
    const store = await openTestAgentSessionRecordStore(root)
    const before = store.getRecord('session-codex')
    expect(before).not.toBeNull()
    await store.backfillChatPermissionModes(() => true)
    expect(store.getRecord('session-codex')).toEqual({ ...before, permissionMode: 'full-access' })
  })

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
