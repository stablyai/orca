// Retry crash-interrupted create ids at the next fence only after recovery releases the old reservation; held reservations replay unchanged.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  AGENT_SESSION_MAX_NEW_OPERATION_AGE_MS,
  AGENT_SESSION_OPERATION_FUTURE_SKEW_MS
} from '../../../../shared/agent-session/lifecycle/operations/agent-session-host-authority'
import type { AgentSessionOwnerProbe } from '../../../../shared/agent-session/lifecycle/leases/agent-session-lease-adjudication'
import type { AgentSessionLease } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import type { AgentSessionRecordStore } from '../records/agent-session-record-store'
import {
  openTestAgentSessionRecordStore,
  closeTestAgentSessionRecordStores
} from '../records/agent-session-record-store-test-harness'
import { withTestAgentSessionDatabase } from '../records/agent-session-record-store-persistence.test-fixture'
import type { AgentSessionReserveRequest } from './agent-session-reservation-admission'
import { codexProviderHandle } from '../../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'

const NOW = 1_800_000_000_000
const SESSION = 'session-alpha'
const OPERATION = `${NOW}-${'1'.padStart(32, '0')}`
const PAST_EXPIRY =
  AGENT_SESSION_MAX_NEW_OPERATION_AGE_MS + AGENT_SESSION_OPERATION_FUTURE_SKEW_MS + 60_000
const INDETERMINATE: AgentSessionOwnerProbe = { outcome: 'indeterminate', reason: 'no answer' }

let directory: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-released-reservation-replay-'))
})

afterEach(async () => {
  await closeTestAgentSessionRecordStores()
  await rm(directory, { recursive: true, force: true })
})

function open(): Promise<AgentSessionRecordStore> {
  return openTestAgentSessionRecordStore(directory)
}

function createRequest(
  overrides: Partial<AgentSessionReserveRequest> = {}
): AgentSessionReserveRequest {
  return {
    sessionId: SESSION,
    location: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'workspace-1',
      workspaceKind: 'git-worktree'
    },
    provider: 'codex',
    accountHome: { variable: 'CODEX_HOME', path: '/home/dev/.codex' },
    expectedFence: null,
    spawnToken: 'spawn-a',
    claimKeyId: 'key-1',
    handoffOperationId: OPERATION,
    probe: INDETERMINATE,
    operation: { callerKey: 'client-1', operationId: OPERATION, fingerprint: 'fp-1' },
    now: NOW,
    ...overrides
  }
}

describe('a create retried after recovery released its reservation', () => {
  it('refuses an expired retry of a session that has no record', async () => {
    const store = await open()
    await expect(store.reserveOwner(createRequest({ now: NOW + PAST_EXPIRY }))).rejects.toThrow(
      'agent_session_operation_expired'
    )
  })

  it.each([
    ['proven alive', { outcome: 'identity-matched', matchedOn: ['spawn-token'] }, 'conflict'],
    ['one nothing could verify', INDETERMINATE, 'ownership_unknown']
  ] as const)('still refuses a retry once its child is live and %s', async (_case, probe, code) => {
    const store = await open()
    await store.reserveOwner(createRequest())
    await store.commitProcessIdentity({
      sessionId: SESSION,
      fence: 1,
      process: { hostId: 'local', pid: 4242, processStartTimeMs: NOW, spawnToken: 'spawn-a' },
      now: NOW
    })
    await store.proveOwner({
      sessionId: SESSION,
      fence: 1,
      link: {
        linkId: 'link-1',
        handle: codexProviderHandle('thread-1'),
        origin: 'created',
        mintedAtFence: 1,
        observedAt: NOW
      },
      now: NOW
    })

    await expect(store.reserveOwner(createRequest({ probe }))).rejects.toThrow(
      `agent_session_${code}`
    )
    expect(store.getRecord(SESSION)?.lease).toMatchObject({ claimStatus: 'live', runtimeFence: 1 })
  })

  it.each<[string, Partial<AgentSessionLease>, string]>([
    ['in recovery', { handoffStage: 'recovering' }, 'agent_session_ownership_unknown'],
    [
      'held by a terminal agent',
      { claimStatus: 'conflicted', handoffStage: 'recovering' },
      'agent_session_conflict'
    ]
  ])('still refuses a retry whose reservation is %s', async (_case, lease, code) => {
    const store = await open()
    await store.reserveOwner(createRequest())
    await withTestAgentSessionDatabase(directory, (db) =>
      db
        .prepare(
          `UPDATE agent_session_records SET record_json=json_patch(record_json,?) WHERE session_id=?`
        )
        .run(JSON.stringify({ lease }), SESSION)
    )

    await expect(store.reserveOwner(createRequest())).rejects.toThrow(code)
    expect(store.getRecord(SESSION)?.lease.runtimeFence).toBe(1)
  })
})
