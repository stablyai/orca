// A create the host was running when it died is retried under the same operation id. Recovery has
// released its reservation by then, so the retry continues it at the next fence; a reservation that
// is still held keeps answering exactly as it did.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AGENT_SESSION_MAX_NEW_OPERATION_AGE_MS,
  AGENT_SESSION_OPERATION_FUTURE_SKEW_MS
} from '../../shared/agent-session-host-authority'
import type { AgentSessionOwnerProbe } from '../../shared/agent-session-lease-adjudication'
import type { AgentSessionLease } from '../../shared/agent-session-record'
import { AgentSessionRecordStore } from './agent-session-record-store'
import type { AgentSessionReserveRequest } from './agent-session-reservation-admission'

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
  await rm(directory, { recursive: true, force: true })
})

function open(): Promise<AgentSessionRecordStore> {
  return AgentSessionRecordStore.open({ directory, hostId: 'local' })
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

/** The create reserved, then a restart that could prove nothing released it at fence 2. */
async function releasedByRestart(now: number): Promise<AgentSessionRecordStore> {
  const first = await open()
  await first.reserveOwner(createRequest())
  const store = await open()
  await store.reconcileOnRestart({ probe: async () => INDETERMINATE, now })
  expect(store.getRecord(SESSION)?.lease).toMatchObject({
    claimStatus: 'released',
    handoffStage: null,
    runtimeFence: 2
  })
  return store
}

describe('a create retried after recovery released its reservation', () => {
  it.each([
    ['its operation row is still pending', 1_000],
    ['its operation row has expired', PAST_EXPIRY]
  ])('continues when %s, and the old reservation can never commit', async (_case, elapsed) => {
    const now = NOW + elapsed
    const store = await releasedByRestart(now)

    const continued = await store.reserveOwner(createRequest({ spawnToken: () => 'spawn-b', now }))
    expect(continued.disposition).toBe('reserved')
    expect(continued.record.lease).toMatchObject({
      claimStatus: 'reserved',
      handoffStage: 'new-owner-proving',
      runtimeFence: 3,
      reservedSpawnToken: 'spawn-b',
      handoffOperationId: OPERATION
    })
    expect(store.listOperationRows()).toEqual([
      expect.objectContaining({ operationId: OPERATION, outcome: { status: 'pending' } })
    ])

    // A spawn from the first reservation reports in late: refused at its fence, and by token.
    const lateSpawn = { hostId: 'local', pid: 4242, processStartTimeMs: NOW, spawnToken: 'spawn-a' }
    await expect(
      store.commitProcessIdentity({ sessionId: SESSION, fence: 1, process: lateSpawn, now })
    ).rejects.toThrow('agent_session_checkpoint_stale')
    await expect(
      store.commitProcessIdentity({ sessionId: SESSION, fence: 3, process: lateSpawn, now })
    ).rejects.toThrow('agent_session_ownership_unknown')

    // Retried again while that reservation stands: the same reservation, never a second spawn.
    const mint = vi.fn(() => 'spawn-c')
    const retried = await store.reserveOwner(createRequest({ spawnToken: mint, now }))
    expect(retried.disposition).toBe('replayed')
    expect(retried.record.lease).toMatchObject({ runtimeFence: 3, reservedSpawnToken: 'spawn-b' })
    expect(mint).not.toHaveBeenCalled()
  })

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
        handle: { provider: 'codex', threadId: 'thread-1' },
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
    await store.transitionHandoff(SESSION, (record) => ({
      ...record,
      lease: { ...record.lease, ...lease }
    }))

    await expect(store.reserveOwner(createRequest())).rejects.toThrow(code)
    expect(store.getRecord(SESSION)?.lease.runtimeFence).toBe(1)
  })
})
