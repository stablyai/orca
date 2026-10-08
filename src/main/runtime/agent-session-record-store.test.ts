import { readTestAgentSessionOperationRows } from './agent-session-operation-test-rows'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentSessionOwnerProbe } from '../../shared/agent-session-lease-adjudication'
import type {
  AgentSessionExecutionLocation,
  AgentSessionLease,
  AgentSessionProcessIdentity,
  AgentSessionRecord
} from '../../shared/agent-session-record'
import type { AgentSessionProviderHandleLink } from '../../shared/agent-session-provider-handle'
import type { PersistedAgentSessionRecord } from '../../shared/agent-session-legacy-handoff-lease'
import type { AgentSessionRecordStore } from './agent-session-record-store'
import {
  editPersistedTestAgentSessionStore,
  openTestAgentSessionRecordStore,
  readPersistedTestAgentSessionStore,
  seedTestAgentSessionStoreFromNewerBuild
} from './agent-session-record-store-test-harness'
import { AGENT_SESSION_CLAIM_KEY_RETENTION_MS } from './agent-session-claim-key-retention'
import { openTestJournalHostDatabase } from '../native-chat/agent-session-journal/journal-host-database-test-support'
import type { AgentSessionReserveRequest } from './agent-session-reservation-admission'
import {
  claudeProviderHandle,
  codexProviderHandle
} from '../../shared/agent-session-provider-handle-encoding'

const NOW = 1_800_000_000_000

const NATIVE: AgentSessionExecutionLocation = {
  executionHostId: 'local',
  wslDistro: null,
  workspaceId: 'workspace-1',
  workspaceKind: 'git-worktree'
}
const WSL: AgentSessionExecutionLocation = { ...NATIVE, wslDistro: 'Ubuntu-22.04' }
const SSH: AgentSessionExecutionLocation = { ...NATIVE, executionHostId: 'ssh:build-box' }
const FOLDER: AgentSessionExecutionLocation = {
  ...NATIVE,
  workspaceId: 'workspace-2',
  workspaceKind: 'folder'
}

const MATCHED: AgentSessionOwnerProbe = { outcome: 'identity-matched', matchedOn: ['spawn-token'] }
const INDETERMINATE: AgentSessionOwnerProbe = { outcome: 'indeterminate', reason: 'no answer' }
const UNUSED: AgentSessionOwnerProbe = { outcome: 'reservation-unused' }

let counter = 0

function operationId(now = NOW): string {
  counter += 1
  return `${now}-${String(counter)
    .padStart(32, '0')
    .replaceAll(/[^0-9a-f]/g, '0')}`
}

function reserveRequest(
  overrides: Partial<AgentSessionReserveRequest> = {}
): AgentSessionReserveRequest {
  return {
    sessionId: 'session-alpha',
    location: NATIVE,
    provider: 'claude',
    accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: '/home/dev/.claude-work' },
    expectedFence: null,
    spawnToken: 'spawn-a',
    claimKeyId: 'key-1',
    handoffOperationId: null,
    probe: INDETERMINATE,
    operation: { callerKey: 'client-1', operationId: operationId(), fingerprint: 'fp-1' },
    now: NOW,
    ...overrides
  }
}

function processIdentity(
  overrides: Partial<AgentSessionProcessIdentity> = {}
): AgentSessionProcessIdentity {
  return {
    hostId: 'local',
    pid: 4242,
    processStartTimeMs: 1_700_000_000_000,
    spawnToken: 'spawn-a',
    ...overrides
  }
}

function handleLink(
  overrides: Partial<AgentSessionProviderHandleLink> = {}
): AgentSessionProviderHandleLink {
  return {
    linkId: 'link-1',
    handle: claudeProviderHandle('provider-session-1', 'leaf-1'),
    origin: 'created',
    mintedAtFence: 1,
    observedAt: NOW,
    ...overrides
  }
}

let directory: string

async function open(hostId = 'local'): Promise<AgentSessionRecordStore> {
  return openTestAgentSessionRecordStore(directory, { hostId })
}

/** Reserve, observe the spawn, prove the handle — the full path to an admitted writer. */
async function establishOwner(
  store: AgentSessionRecordStore,
  overrides: Partial<AgentSessionReserveRequest> = {}
): Promise<AgentSessionRecord> {
  const reserved = await store.reserveOwner(reserveRequest(overrides))
  const fence = reserved.record.lease.runtimeFence
  const sessionId = reserved.record.sessionId
  await store.commitProcessIdentity({
    sessionId,
    fence,
    process: processIdentity({ spawnToken: reserved.record.lease.reservedSpawnToken ?? 'spawn-a' }),
    now: NOW
  })
  return store.proveOwner({
    sessionId,
    fence,
    link: handleLink({ mintedAtFence: fence }),
    now: NOW
  })
}

/** The shape the removed conflict marker wrote, as it decodes. No shipped build called it; a record
 *  may carry it. */
async function markLegacyConflicted(
  store: AgentSessionRecordStore,
  lease: Partial<AgentSessionLease> = {}
): Promise<void> {
  if (!store.getRecord('session-alpha')) {
    await store.reserveOwner(reserveRequest())
  }
  await store.transitionHandoff('session-alpha', (record) => ({
    ...record,
    lease: {
      ...record.lease,
      claimStatus: 'conflicted',
      handoffStage: 'recovering',
      ...lease
    }
  }))
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-agent-session-store-'))
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

describe('acquisition path', () => {
  it('admits a writer only after reservation, observed identity, and a proved handle', async () => {
    const store = await open()
    const reserved = await store.reserveOwner(reserveRequest())
    expect(reserved.disposition).toBe('created')
    expect(reserved.record.lease).toMatchObject({
      runtimeFence: 1,
      claimStatus: 'reserved',
      handoffStage: 'new-owner-proving',
      ownerProcess: null,
      reservedSpawnToken: 'spawn-a'
    })

    // Proving before the spawn is observed is refused.
    await expect(
      store.proveOwner({ sessionId: 'session-alpha', fence: 1, link: handleLink(), now: NOW })
    ).rejects.toThrow('agent_session_ownership_unknown')

    await store.commitProcessIdentity({
      sessionId: 'session-alpha',
      fence: 1,
      process: processIdentity(),
      now: NOW
    })
    const proved = await store.proveOwner({
      sessionId: 'session-alpha',
      fence: 1,
      link: handleLink(),
      now: NOW
    })
    expect(proved.lease).toMatchObject({
      claimStatus: 'live',
      handoffStage: null,
      provenHandleLinkId: 'link-1',
      runtimeFence: 1
    })
    expect(proved.providerHandleChain).toHaveLength(1)
  })

  it('refuses a child that cannot echo the reserved spawn token', async () => {
    const store = await open()
    await store.reserveOwner(reserveRequest())
    await expect(
      store.commitProcessIdentity({
        sessionId: 'session-alpha',
        fence: 1,
        process: processIdentity({ spawnToken: 'spawn-other' }),
        now: NOW
      })
    ).rejects.toThrow('agent_session_ownership_unknown')
  })

  it('accepts provider proof only for the reserved provider at the current fence', async () => {
    const store = await open()
    await store.reserveOwner(reserveRequest())
    await store.commitProcessIdentity({
      sessionId: 'session-alpha',
      fence: 1,
      process: processIdentity(),
      now: NOW
    })

    await expect(
      store.proveOwner({
        sessionId: 'session-alpha',
        fence: 1,
        link: handleLink({
          handle: codexProviderHandle('thread-1')
        }),
        now: NOW
      })
    ).rejects.toThrow('agent_session_provider_handle_provider_mismatch')
    await expect(
      store.proveOwner({
        sessionId: 'session-alpha',
        fence: 1,
        link: handleLink({ mintedAtFence: 2 }),
        now: NOW
      })
    ).rejects.toThrow('agent_session_provider_handle_stale_fence')
  })

  it('does not let an established owner re-enter the proof transition', async () => {
    const store = await open()
    await establishOwner(store)

    await expect(
      store.proveOwner({
        sessionId: 'session-alpha',
        fence: 1,
        link: handleLink({
          linkId: 'link-2',
          origin: 'resumed',
          observedAt: NOW + 1
        }),
        now: NOW + 1
      })
    ).rejects.toThrow('agent_session_ownership_unknown')
  })

  it('refuses a create that carries a fence and a re-create that does not', async () => {
    const store = await open()
    await expect(store.reserveOwner(reserveRequest({ expectedFence: 0 }))).rejects.toThrow(
      'agent_session_checkpoint_stale'
    )
    await establishOwner(store)
    await expect(store.reserveOwner(reserveRequest({ expectedFence: null }))).rejects.toThrow(
      'agent_session_conflict'
    )
  })

  it.each([
    [
      'provider',
      { provider: 'codex', accountHome: { variable: 'CODEX_HOME', path: '/home/dev/.codex' } }
    ],
    ['account', { accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: '/home/dev/.claude-other' } }]
  ] as const)("refuses to change a session's pinned %s", async (_name, overrides) => {
    const store = await open()
    await establishOwner(store)
    await expect(
      store.reserveOwner(
        reserveRequest({
          ...overrides,
          expectedFence: 1,
          probe: { outcome: 'pid-absent' },
          operation: { callerKey: 'client-1', operationId: operationId(), fingerprint: 'fp-2' }
        })
      )
    ).rejects.toThrow('agent_session_conflict')
  })
})

describe('concurrent claims', () => {
  it('lets exactly one of two concurrent reservations win and never spawns the loser', async () => {
    const store = await open()
    await establishOwner(store)
    const request = () =>
      reserveRequest({
        expectedFence: 1,
        probe: { outcome: 'pid-absent' },
        spawnToken: 'spawn-b',
        operation: { callerKey: 'client-1', operationId: operationId(), fingerprint: 'fp-2' }
      })
    const results = await Promise.allSettled([
      store.reserveOwner(request()),
      store.reserveOwner(request())
    ])
    const granted = results.filter((result) => result.status === 'fulfilled')
    expect(granted).toHaveLength(1)
    const refused = results.find((result) => result.status === 'rejected')
    expect((refused as PromiseRejectedResult).reason.message).toBe('agent_session_checkpoint_stale')
    expect(store.getRecord('session-alpha')?.lease.runtimeFence).toBe(2)
  })

  it('serializes concurrent creates of the same session id', async () => {
    const store = await open()
    const results = await Promise.allSettled([
      store.reserveOwner(reserveRequest()),
      store.reserveOwner(reserveRequest())
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(store.getRecord('session-alpha')?.lease.runtimeFence).toBe(1)
  })

  it('replays a retried operation id instead of reserving twice', async () => {
    const store = await open()
    const operation = { callerKey: 'client-1', operationId: operationId(), fingerprint: 'fp-1' }
    const first = await store.reserveOwner(reserveRequest({ operation }))
    const second = await store.reserveOwner(reserveRequest({ operation }))
    expect(second.disposition).toBe('replayed')
    expect(second.record.lease.runtimeFence).toBe(first.record.lease.runtimeFence)
    expect(readTestAgentSessionOperationRows(store)).toHaveLength(1)
  })

  it('refuses the same operation id carrying different parameters', async () => {
    const store = await open()
    const operationId_ = operationId()
    await store.reserveOwner(
      reserveRequest({
        operation: { callerKey: 'client-1', operationId: operationId_, fingerprint: 'fp-1' }
      })
    )
    await expect(
      store.reserveOwner(
        reserveRequest({
          sessionId: 'session-beta',
          operation: { callerKey: 'client-1', operationId: operationId_, fingerprint: 'fp-9' }
        })
      )
    ).rejects.toThrow('agent_session_operation_conflict')
  })

  it('rolls the in-memory state back when a transaction throws', async () => {
    const store = await open()
    await establishOwner(store)
    const before = store.getRecord('session-alpha')
    await expect(
      store.reserveOwner(reserveRequest({ expectedFence: 1, probe: INDETERMINATE }))
    ).rejects.toThrow('agent_session_ownership_unknown')
    expect(store.getRecord('session-alpha')).toEqual(before)
    expect(readTestAgentSessionOperationRows(store)).toHaveLength(1)
  })

  it('never keeps a change in memory that failed to commit to disk', async () => {
    const store = await open()
    await establishOwner(store)
    const before = store.getRecord('session-alpha')
    const persistedBefore = await readPersistedTestAgentSessionStore(directory)
    // The row write fails inside the commit, as a full disk or an I/O error would.
    openTestJournalHostDatabase(directory).db.exec(
      "CREATE TRIGGER fail_record_write BEFORE UPDATE ON agent_session_records BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END"
    )
    await expect(store.setConversationName('session-alpha', 'renamed')).rejects.toThrow(
      'disk I/O error'
    )
    expect(store.getRecord('session-alpha')).toBe(before)
    expect(await readPersistedTestAgentSessionStore(directory)).toEqual(persistedBefore)
  })
})

describe('expiry is not eviction', () => {
  it('never grants a second owner on a lapsed deadline alone', async () => {
    const store = await open()
    const owned = await establishOwner(store)
    const wellPastDeadline = owned.lease.leaseDeadlineAt + 60 * 60 * 1000
    for (const probe of [INDETERMINATE, MATCHED] as const) {
      await expect(
        store.reserveOwner(
          reserveRequest({
            expectedFence: 1,
            probe,
            now: wellPastDeadline,
            operation: {
              callerKey: 'client-1',
              operationId: operationId(wellPastDeadline),
              fingerprint: 'fp-2'
            }
          })
        )
      ).rejects.toThrow(/agent_session_(ownership_unknown|conflict)/)
    }
    expect(store.getRecord('session-alpha')?.lease.runtimeFence).toBe(1)

    // Only proof of death moves it.
    const evicted = await store.evictProvenDeadOwner({
      sessionId: 'session-alpha',
      expectedFence: 1,
      probe: { outcome: 'pid-absent' },
      now: wellPastDeadline
    })
    expect(evicted.lease).toMatchObject({ runtimeFence: 2, claimStatus: 'released' })
    expect(evicted.lease.deathEvidence?.kind).toBe('pid-absent')
  })

  it('refuses to evict an owner it cannot prove dead', async () => {
    const store = await open()
    await establishOwner(store)
    await expect(
      store.evictProvenDeadOwner({
        sessionId: 'session-alpha',
        expectedFence: 1,
        probe: INDETERMINATE,
        now: NOW
      })
    ).rejects.toThrow('agent_session_ownership_unknown')
  })

  it('stops renewing a lease it can no longer vouch for', async () => {
    const store = await open()
    await establishOwner(store)
    const renewed = await store.renewLease({
      sessionId: 'session-alpha',
      fence: 1,
      childProbe: MATCHED,
      now: NOW + 5_000
    })
    expect(renewed.lease.lastRenewedAt).toBe(NOW + 5_000)
    await expect(
      store.renewLease({
        sessionId: 'session-alpha',
        fence: 1,
        childProbe: { outcome: 'identity-matched', matchedOn: [] },
        now: NOW + 10_000
      })
    ).rejects.toThrow('agent_session_ownership_unknown')
  })
})

describe('restart reconciliation', () => {
  it('survives a restart and grants no writer until adjudicated', async () => {
    const first = await open()
    await establishOwner(first)

    const reopened = await open()
    const loaded = reopened.getRecord('session-alpha')
    expect(loaded?.lease.unreconciled).toBe(true)
    expect(loaded?.providerHandleChain).toHaveLength(1)
    expect(loaded?.accountHome).toEqual({
      variable: 'CLAUDE_CONFIG_DIR',
      path: '/home/dev/.claude-work'
    })
    // Every mutating path is closed while unreconciled.
    await expect(
      reopened.renewLease({ sessionId: 'session-alpha', fence: 1, childProbe: MATCHED, now: NOW })
    ).rejects.toThrow('execution_owner_reconciling')
    await expect(
      reopened.reserveOwner(
        reserveRequest({
          expectedFence: 1,
          probe: { outcome: 'pid-absent' },
          operation: { callerKey: 'client-1', operationId: operationId(), fingerprint: 'fp-2' }
        })
      )
    ).rejects.toThrow('execution_owner_reconciling')
  })

  it('re-adopts a live owner without moving the fence', async () => {
    const first = await open()
    await establishOwner(first)
    const reopened = await open()
    await reopened.reconcileOnRestart({ probe: async () => MATCHED, now: NOW + 1_000 })
    const record = reopened.getRecord('session-alpha')
    expect(record?.lease).toMatchObject({
      unreconciled: false,
      runtimeFence: 1,
      claimStatus: 'live'
    })
    expect(record?.lease.provenHandleLinkId).toBe('link-1')
  })

  it('never applies a stale restart probe to a lease another reconcile already settled', async () => {
    await establishOwner(await open())
    const store = await open()
    let releaseProbe!: (probe: AgentSessionOwnerProbe) => void
    let markProbeStarted!: () => void
    const probeStarted = new Promise<void>((resolve) => (markProbeStarted = resolve))
    const probeResult = new Promise<AgentSessionOwnerProbe>((resolve) => (releaseProbe = resolve))
    const stale = store.reconcileOnRestart({
      probe: async () => {
        markProbeStarted()
        return probeResult
      },
      now: NOW + 1_000
    })

    await probeStarted
    const settled = await store.reconcileOnRestart({ probe: async () => MATCHED, now: NOW + 500 })
    expect(settled.get('session-alpha')?.lease).toMatchObject({ claimStatus: 'live' })

    releaseProbe({ outcome: 'pid-absent' })
    expect(await stale).toEqual(new Map())
    const persisted = await readPersistedTestAgentSessionStore(directory)
    expect(persisted.records['session-alpha'].lease).toMatchObject({
      runtimeFence: 1,
      claimStatus: 'live',
      ownerProcess: { pid: 4242, spawnToken: 'spawn-a' },
      unreconciled: false
    })
  })

  it('keeps the fence monotonic across a restart and never reuses a retired fence', async () => {
    const first = await open()
    await establishOwner(first)
    await first.evictProvenDeadOwner({
      sessionId: 'session-alpha',
      expectedFence: 1,
      probe: { outcome: 'exit-observed' },
      now: NOW
    })

    const second = await open()
    await second.reconcileOnRestart({ probe: async () => UNUSED, now: NOW + 1_000 })
    const afterRestart = second.getRecord('session-alpha')?.lease.runtimeFence ?? 0
    expect(afterRestart).toBeGreaterThanOrEqual(2)

    const reacquired = await second.reserveOwner(
      reserveRequest({
        expectedFence: afterRestart,
        probe: UNUSED,
        spawnToken: 'spawn-b',
        operation: {
          callerKey: 'client-1',
          operationId: operationId(NOW + 1_000),
          fingerprint: 'fp-2'
        },
        now: NOW + 1_000
      })
    )
    expect(reacquired.record.lease.runtimeFence).toBe(afterRestart + 1)

    const third = await open()
    expect(third.getRecord('session-alpha')?.lease.runtimeFence).toBe(afterRestart + 1)
  })

  it('sends an unverifiable owner to recovery rather than releasing it', async () => {
    const first = await open()
    await establishOwner(first)
    const reopened = await open()
    await reopened.reconcileOnRestart({ probe: async () => INDETERMINATE, now: NOW + 1_000 })
    const lease = reopened.getRecord('session-alpha')?.lease
    expect(lease).toMatchObject({ handoffStage: 'recovering', runtimeFence: 1 })
    expect(lease?.ownerProcess).not.toBeNull()
    await expect(
      reopened.reserveOwner(
        reserveRequest({
          expectedFence: 1,
          probe: { outcome: 'pid-absent' },
          operation: {
            callerKey: 'client-1',
            operationId: operationId(NOW + 1_000),
            fingerprint: 'fp-2'
          },
          now: NOW + 1_000
        })
      )
    ).rejects.toThrow('agent_session_ownership_unknown')
  })

  it('re-adjudicates a claim an older record marked conflicted by the owner it names', async () => {
    const first = await open()
    await establishOwner(first)
    await markLegacyConflicted(first)

    const reopened = await open()
    await reopened.reconcileOnRestart({
      probe: async () => ({ outcome: 'indeterminate', reason: 'no answer' }),
      now: NOW
    })
    // An unverifiable owner goes to recovery like any other; resolution concludes about it.
    expect(reopened.getRecord('session-alpha')?.lease).toMatchObject({
      handoffStage: 'recovering',
      ownerProcess: { pid: expect.any(Number) }
    })
  })

  it('releases a claim an older record marked conflicted that names no process', async () => {
    const first = await open()
    await markLegacyConflicted(first, { ownerProcess: null })

    const reopened = await open()
    await reopened.reconcileOnRestart({
      probe: async () => ({ outcome: 'indeterminate', reason: 'no answer' }),
      now: NOW
    })
    expect(reopened.getRecord('session-alpha')?.lease).toMatchObject({
      claimStatus: 'released',
      handoffStage: null,
      deathEvidence: null
    })
  })

  it('releases a conflict whose named owner is proven gone at restart', async () => {
    // A conflict with no exit is a session the user can never open again; present-time proof that
    // the process the conflict names has exited leaves no claimant left to protect.
    const first = await open()
    await establishOwner(first)
    await markLegacyConflicted(first)

    const reopened = await open()
    await reopened.reconcileOnRestart({ probe: async () => ({ outcome: 'pid-absent' }), now: NOW })

    const lease = reopened.getRecord('session-alpha')?.lease
    expect(lease).toMatchObject({
      claimStatus: 'released',
      handoffStage: null,
      deathEvidence: { kind: 'pid-absent' }
    })
    const reacquired = await reopened.reserveOwner(
      reserveRequest({
        expectedFence: lease?.runtimeFence ?? null,
        probe: { outcome: 'pid-absent' },
        operation: { callerKey: 'client-1', operationId: operationId(), fingerprint: 'fp-2' }
      })
    )
    expect(reacquired.disposition).toBe('reserved')
  })

  it('frees a reservation that provably never spawned', async () => {
    const first = await open()
    await first.reserveOwner(reserveRequest())
    const reopened = await open()
    await reopened.reconcileOnRestart({ probe: async () => UNUSED, now: NOW + 1_000 })
    expect(reopened.getRecord('session-alpha')?.lease).toMatchObject({
      claimStatus: 'released',
      runtimeFence: 2,
      reservedSpawnToken: null
    })
  })

  it('carries the operation ledger across a restart so a retry is still a replay', async () => {
    const operation = { callerKey: 'client-1', operationId: operationId(), fingerprint: 'fp-1' }
    const first = await open()
    await first.reserveOwner(reserveRequest({ operation }))
    await first.recordOperationOutcome({
      callerKey: operation.callerKey,
      operationId: operation.operationId,
      outcome: { status: 'succeeded', sessionId: 'session-alpha' }
    })

    const reopened = await open()
    expect(readTestAgentSessionOperationRows(reopened)).toHaveLength(1)
    const replayed = await reopened.reserveOwner(reserveRequest({ operation }))
    expect(replayed.disposition).toBe('replayed')
    expect(replayed.record.sessionId).toBe('session-alpha')
  })
})

describe('host and workspace isolation', () => {
  it.each([
    ['WSL', WSL],
    ['SSH', SSH],
    ['another workspace', FOLDER],
    ['another workspace kind', { ...NATIVE, workspaceKind: 'folder' }]
  ] as const)('refuses to move one session id to %s', async (_name, location) => {
    const store = await open()
    await establishOwner(store)
    await expect(
      store.reserveOwner(
        reserveRequest({
          location,
          expectedFence: 1,
          probe: { outcome: 'pid-absent' },
          operation: { callerKey: 'client-1', operationId: operationId(), fingerprint: 'fp-2' }
        })
      )
    ).rejects.toThrow('agent_session_conflict')
  })

  it('keeps native, WSL, and SSH sessions in separate scopes', async () => {
    const store = await open()
    await establishOwner(store, { sessionId: '__proto__' })
    await establishOwner(store, { sessionId: 'session-wsl', location: WSL, spawnToken: 'spawn-b' })
    await establishOwner(store, { sessionId: 'session-ssh', location: SSH, spawnToken: 'spawn-c' })
    await establishOwner(store, {
      sessionId: 'session-folder',
      location: FOLDER,
      spawnToken: 'spawn-d'
    })

    expect(store.listByScope(NATIVE).map((record) => record.sessionId)).toEqual(['__proto__'])
    expect(store.listByScope(WSL).map((record) => record.sessionId)).toEqual(['session-wsl'])
    expect(store.listByScope(SSH).map((record) => record.sessionId)).toEqual(['session-ssh'])
    expect(store.listByScope(FOLDER).map((record) => record.sessionId)).toEqual(['session-folder'])
    expect((await open()).getRecord('__proto__')).not.toBeNull()
  })

  it('preserves the workspace kind so a folder workspace is never read back as a worktree', async () => {
    const first = await open()
    await establishOwner(first, { sessionId: 'session-folder', location: FOLDER })
    const reopened = await open()
    expect(reopened.getRecord('session-folder')?.location).toEqual(FOLDER)
  })
})

describe('claim keys and unreadable rows', () => {
  it('keeps a retired claim key verifiable for the retention window', async () => {
    const store = await open()
    await store.retireClaimKey('key-1', NOW)
    expect(store.isClaimKeyVerifiable('key-1', NOW + AGENT_SESSION_CLAIM_KEY_RETENTION_MS)).toBe(
      true
    )
    expect(
      store.isClaimKeyVerifiable('key-1', NOW + AGENT_SESSION_CLAIM_KEY_RETENTION_MS + 1)
    ).toBe(false)
    expect(store.isClaimKeyVerifiable('key-unknown', NOW)).toBe(true)
  })

  it.each([
    [
      'invalid checkpoint',
      (record: PersistedAgentSessionRecord) =>
        Object.assign(record.lease, { journalCheckpoint: { epoch: 'bad', sequence: 1 } })
    ],
    [
      'missing live proof',
      (record: PersistedAgentSessionRecord) =>
        Object.assign(record.lease, { provenHandleLinkId: null })
    ]
  ])('quarantines a record with %s', async (_name, corrupt) => {
    const first = await open()
    await establishOwner(first)
    await editPersistedTestAgentSessionStore(directory, (persisted) => {
      corrupt(persisted.records['session-alpha'])
    })
    expect((await open()).isSessionUnreadable('session-alpha')).toBe(true)
  })

  it('sets aside a row whose handle is in both stored forms and never rewrites it', async () => {
    const first = await open()
    await establishOwner(first)
    let ambiguous: PersistedAgentSessionRecord | undefined
    await editPersistedTestAgentSessionStore(directory, (persisted) => {
      ambiguous = persisted.records['session-alpha']
      Object.assign(ambiguous.providerHandleChain[0].handle, {
        transport: 'acp',
        agent: 'grok',
        nativeId: 'acp-thread',
        resumeCursor: 'resume-token'
      })
    })
    const reopened = await open()
    expect(reopened.isSessionUnreadable('session-alpha')).toBe(true)
    // Another chat's write must carry the set-aside row through untouched.
    await establishOwner(reopened, { sessionId: 'session-beta', claimKeyId: 'key-2' })
    expect((await open()).isSessionUnreadable('session-alpha')).toBe(true)
    expect((await readPersistedTestAgentSessionStore(directory)).records['session-alpha']).toEqual(
      ambiguous
    )
  })

  it('refuses to write a store a newer Orca wrote, with the refusal clients print as "update"', async () => {
    await seedTestAgentSessionStoreFromNewerBuild(directory)
    const store = await open()
    expect(store.readOnly).toBe(true)
    await expect(store.reserveOwner(reserveRequest())).rejects.toMatchObject({
      refusal: {
        code: 'agent_session_journal_unreadable',
        details: { reason: 'journalWrittenByNewerOrca' }
      }
    })
  })
})
