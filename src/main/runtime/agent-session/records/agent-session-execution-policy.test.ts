import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import {
  editPersistedTestAgentSessionStore,
  openTestAgentSessionRecordStore
} from './agent-session-record-store-test-harness'
import { closeTestJournalHostDatabases } from '../../../native-chat/agent-session-journal/store-lifecycle/journal-host-database-test-support'

let directory: string
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-execution-policy-'))
})
afterEach(async () => {
  await closeTestJournalHostDatabases()
  await rm(directory, { recursive: true, force: true })
})

const request = () => ({
  sessionId: 'session-bounded',
  location: {
    executionHostId: 'local' as const,
    wslDistro: null,
    workspaceId: 'folder-1',
    workspaceKind: 'folder' as const
  },
  provider: 'codex',
  accountHome: { variable: 'CODEX_HOME' as const, path: '/account' },
  options: { model: 'gpt-live', effort: 'low' },
  executionPolicy: {
    schema: 1 as const,
    sourcePin: 'a'.repeat(40),
    accountFingerprint: `codex:${'b'.repeat(64)}`,
    model: 'gpt-live',
    effort: 'low',
    deadlineAt: 1_800_000_120_000,
    access: 'read-only' as const
  },
  expectedFence: null,
  spawnToken: 'spawn-a',
  claimKeyId: 'key-1',
  handoffOperationId: null,
  probe: { outcome: 'indeterminate' as const, reason: 'no answer' },
  operation: {
    callerKey: 'client-1',
    operationId: '1800000000000-00000000000000000000000000000001',
    fingerprint: 'fp-1'
  },
  now: 1_800_000_000_000
})

it('persists bounded Codex intent and quarantines it if a reader loses its policy version', async () => {
  const store = await openTestAgentSessionRecordStore(directory, { hostId: 'local' })
  const input = request()
  await store.founding.commit(input)
  input.executionPolicy.model = 'changed'
  const reopened = await openTestAgentSessionRecordStore(directory, { hostId: 'local' })
  expect(reopened.getRecord('session-bounded')).toMatchObject({
    schemaVersion: 4,
    executionPolicy: { model: 'gpt-live', deadlineAt: 1_800_000_120_000 }
  })
  expect(reopened.getConversation('session-bounded')).not.toHaveProperty('executionPolicy')
  await editPersistedTestAgentSessionStore(directory, (persisted) => {
    persisted.records['session-bounded'].schemaVersion = 2
  })
  const downgraded = await openTestAgentSessionRecordStore(directory, { hostId: 'local' })
  expect(downgraded.getRecord('session-bounded')).toBeNull()
  expect(downgraded.selectWritableRecord('session-bounded').kind).toBe('unreadable')
})

it('refuses expired or mismatched execution intent before reserving an owner', async () => {
  const store = await openTestAgentSessionRecordStore(directory, { hostId: 'local' })
  for (const change of [
    { deadlineAt: 1_800_000_000_000 },
    { deadlineAt: 1_800_000_300_001 },
    { model: 'different-model' }
  ]) {
    const input = request()
    Object.assign(input.executionPolicy, change)
    await expect(store.reserveOwner(input)).rejects.toMatchObject({
      refusal: { code: 'agent_session_operation_invalid' }
    })
    expect(store.getRecord('session-bounded')).toBeNull()
  }
})
