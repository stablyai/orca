// Every lease loads unreconciled. A create over the record an older host's failed start left must
// adjudicate that lease itself, as a start does: the create refuses one still unreconciled, and
// nothing else on the create path would clear it, so the chat's relaunch would be refused forever.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  hostTestAttachParams,
  hostTestOperationId
} from './structured-agent-session-host-test-data'
import { createStructuredAgentSessionLogger } from './structured-agent-session-logger'

let root: string
let host: StructuredAgentSessionHost | null = null

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-create-reconciles-first-'))
})

afterEach(async () => {
  await host?.flushAllStreamedEvents()
  host = null
  await rm(root, { recursive: true, force: true })
})

/** What an older host left: its create reserved the record, the start failed and was proven gone. */
async function leaveFailedCreate(): Promise<number> {
  const store = await openTestAgentSessionRecordStore(root)
  const params = hostTestAttachParams(null)
  const identity = {
    sessionId: SESSION,
    location: params.location,
    provider: params.provider,
    accountHome: params.accountHome
  }
  const operation = { callerKey: 'client-1', operationId: hostTestOperationId() }
  await store.createAtRest({
    ...identity,
    claimKeyId: 'key-1',
    operation: { ...operation, fingerprint: 'old-create' },
    now: NOW
  })
  const reserved = await store.reserveOwner({
    ...identity,
    expectedFence: 1,
    spawnToken: 'spawn-old',
    claimKeyId: 'key-1',
    handoffOperationId: operation.operationId,
    probe: { outcome: 'reservation-unused' },
    operation: { ...operation, fingerprint: 'old-create' },
    now: NOW
  })
  await store.settleFailedAcquisition({
    sessionId: SESSION,
    fence: reserved.record.lease.runtimeFence,
    spawnToken: 'spawn-old',
    ...operation,
    outcome: { status: 'failed', code: 'agent_session_operation_invalid', message: 'signed out' },
    exitProof: 'exit-proven',
    now: NOW
  })
  return store.getRecord(SESSION)!.lease.runtimeFence
}

it('adjudicates an unreconciled lease, then founds the chat again at the next fence', async () => {
  const leftFence = await leaveFailedCreate()
  // A fresh process: every lease it loads is unreconciled until adjudicated.
  const store = await openTestAgentSessionRecordStore(root)
  expect(store.getRecord(SESSION)?.lease.unreconciled).toBe(true)
  host = new StructuredAgentSessionHost({
    logger: createStructuredAgentSessionLogger(),
    store,
    adapter: {
      supportsCreate: () => true,
      acquire: vi.fn(),
      dispatch: vi.fn(),
      cancelTurn: vi.fn(),
      answerPrompt: vi.fn(),
      setOption: vi.fn()
    },
    journalDatabase: openTestJournalHostDatabase(root),
    claimKeyId: 'key-1',
    now: () => NOW,
    probeOwner: async () => ({ outcome: 'pid-absent' })
  })

  const created = await host.create({ callerKey: 'client-1' }, hostTestAttachParams(null))

  expect(created).toMatchObject({ ok: true, replayed: false, fence: leftFence + 1 })
  expect(store.getRecord(SESSION)?.lease).toMatchObject({
    unreconciled: false,
    claimStatus: 'released',
    deathEvidence: null
  })
})
