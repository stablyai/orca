import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import {
  agentSessionOperationExpiry,
  agentSessionOperationKey
} from '../../shared/agent-session-operation-ledger'
import {
  openTestAgentSessionRecordStore,
  readPersistedTestAgentSessionStore
} from './agent-session-record-store-test-harness'

const NOW = 1_800_000_000_000
let root: string | undefined
afterEach(async () => {
  if (root) {
    await rm(root, { recursive: true, force: true })
  }
  root = undefined
})

it('keeps a settled receipt through restart, then deletes it without readmitting its retry', async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-operation-retention-'))
  const operation = {
    callerKey: 'client-1',
    operationId: `${NOW}-${'a'.repeat(32)}`,
    fingerprint: 'original-send',
    now: NOW
  }
  const store = await openTestAgentSessionRecordStore(root)
  const admitted = await store.admitGlobalOperation(operation)
  if (admitted.decision !== 'admit') {
    throw new Error('expected admitted operation')
  }
  await store.recordOperationOutcome({
    ...operation,
    outcome: { status: 'succeeded', sessionId: 'session-1' }
  })
  const reopened = await openTestAgentSessionRecordStore(root)
  const expiresAt = agentSessionOperationExpiry(NOW, NOW)
  expect(
    await reopened.admitGlobalOperation({
      ...operation,
      callerKey: 'reconnected-client',
      now: expiresAt - 1
    })
  ).toMatchObject({
    decision: 'replay',
    row: { callerKey: 'client-1', outcome: { status: 'succeeded' } }
  })
  const key = agentSessionOperationKey(operation.callerKey, operation.operationId)
  expect((await readPersistedTestAgentSessionStore(root)).operations[key]).toBeDefined()

  expect(
    await reopened.admitGlobalOperation({
      ...operation,
      operationId: `${expiresAt}-${'b'.repeat(32)}`,
      now: expiresAt
    })
  ).toMatchObject({ decision: 'admit' })
  expect((await readPersistedTestAgentSessionStore(root)).operations[key]).toBeUndefined()
  expect(await reopened.admitGlobalOperation({ ...operation, now: expiresAt })).toMatchObject({
    decision: 'refused',
    code: 'agent_session_operation_expired'
  })
  expect(reopened.listOperationRows()).toHaveLength(1)
})
