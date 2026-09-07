import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentSessionOwnerProbe } from '../../shared/agent-session-lease-adjudication'
import type {
  AgentSessionExecutionLocation,
  AgentSessionProcessIdentity,
  AgentSessionRecord
} from '../../shared/agent-session-record'
import type { AgentSessionProviderHandleLink } from '../../shared/agent-session-provider-handle'
import { setStoredAgentSessionHandoffStage } from './agent-session-handoff-record-transitions'
import {
  AGENT_SESSION_CLAIM_KEY_RETENTION_MS,
  AgentSessionRecordStore
} from './agent-session-record-store'
import {
  agentSessionStorePath,
  AGENT_SESSION_STORE_FILE_NAME
} from './agent-session-record-store-file'
import type { AgentSessionReserveRequest } from './agent-session-reservation-admission'

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
const BAD_OP_STORE = '{"schemaVersion":0,"hostId":"","records":{},"operations":{"x":0}}'
const BAD_KEY_STORE =
  '{"schemaVersion":1,"hostId":"","records":{},"operations":{},"retiredClaimKeys":[0]}'

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
    runtimeKind: 'native',
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
    handle: { provider: 'claude', sessionId: 'provider-session-1', leafUuid: 'leaf-1' },
    origin: 'created',
    mintedAtFence: 1,
    observedAt: NOW,
    ...overrides
  }
}

let directory: string

async function open(hostId = 'local'): Promise<AgentSessionRecordStore> {
  return AgentSessionRecordStore.open({ directory, hostId })
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
          handle: { provider: 'codex', threadId: 'thread-1' }
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
  it('lets only one store instance reserve a session from the same disk snapshot', async () => {
    const [first, second] = await Promise.all([open(), open()])
    const results = await Promise.allSettled([
      first.reserveOwner(reserveRequest()),
      second.reserveOwner(reserveRequest())
    ])

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const refused = results.find((result) => result.status === 'rejected')
    expect((refused as PromiseRejectedResult).reason.message).toBe('agent_session_conflict')

    const persisted = await open()
    expect(persisted.getRecord('session-alpha')?.lease.runtimeFence).toBe(1)
    expect(persisted.listOperationRows()).toHaveLength(1)
  })

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
    expect(store.listOperationRows()).toHaveLength(1)
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
    expect(store.listOperationRows()).toHaveLength(1)
  })

  it('never keeps a change in memory that failed to commit to disk', async () => {
    const store = await open()
    await establishOwner(store)
    const before = store.getRecord('session-alpha')
    // Losing both committed copies must not reset the live store to empty authority.
    await rm(directory, { recursive: true, force: true })
    await expect(
      store.setJournalCheckpoint({
        sessionId: 'session-alpha',
        fence: 1,
        checkpoint: { epoch: 9, sequence: 9 },
        now: NOW
      })
    ).rejects.toThrow()
    expect(store.getRecord('session-alpha')).toEqual(before)
    expect(store.getRecord('session-alpha')?.lease.journalCheckpoint).toBeNull()
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

  it('never applies a stale restart probe to a replacement owner', async () => {
    const writer = await open()
    await establishOwner(writer)
    const reconciler = await open()
    let releaseProbe!: (probe: AgentSessionOwnerProbe) => void
    let markProbeStarted!: () => void
    const probeStarted = new Promise<void>((resolve) => (markProbeStarted = resolve))
    const probeResult = new Promise<AgentSessionOwnerProbe>((resolve) => (releaseProbe = resolve))
    const reconciliation = reconciler.reconcileOnRestart({
      probe: async () => {
        markProbeStarted()
        return probeResult
      },
      now: NOW + 1_000
    })

    await probeStarted
    await writer.evictProvenDeadOwner({
      sessionId: 'session-alpha',
      expectedFence: 1,
      probe: { outcome: 'pid-absent' },
      now: NOW + 100
    })
    const replacement = await writer.reserveOwner(
      reserveRequest({
        expectedFence: 2,
        probe: UNUSED,
        spawnToken: 'spawn-b',
        operation: {
          callerKey: 'client-1',
          operationId: operationId(NOW + 200),
          fingerprint: 'fp-2'
        },
        now: NOW + 200
      })
    )
    await writer.commitProcessIdentity({
      sessionId: 'session-alpha',
      fence: replacement.record.lease.runtimeFence,
      process: processIdentity({ pid: 5252, spawnToken: 'spawn-b' }),
      now: NOW + 300
    })
    await writer.proveOwner({
      sessionId: 'session-alpha',
      fence: replacement.record.lease.runtimeFence,
      link: handleLink({ linkId: 'link-2', origin: 'resumed', mintedAtFence: 3 }),
      now: NOW + 300
    })

    releaseProbe({ outcome: 'pid-absent' })
    expect(await reconciliation).toEqual(new Map())
    const persisted = JSON.parse(await readFile(agentSessionStorePath(directory), 'utf-8'))
    expect(persisted.records['session-alpha'].lease).toMatchObject({
      runtimeFence: 3,
      claimStatus: 'live',
      ownerProcess: { pid: 5252, spawnToken: 'spawn-b' },
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

  it('keeps a conflict conflicted across a restart that proves nothing', async () => {
    const first = await open()
    await establishOwner(first)
    await first.markClaimConflicted('session-alpha', NOW)

    const reopened = await open()
    await reopened.reconcileOnRestart({
      probe: async () => ({ outcome: 'indeterminate', reason: 'no answer' }),
      now: NOW
    })
    expect(reopened.getRecord('session-alpha')?.lease).toMatchObject({
      claimStatus: 'conflicted',
      handoffStage: 'manual-recovery'
    })
    await expect(
      reopened.reserveOwner(
        reserveRequest({
          expectedFence: 1,
          probe: { outcome: 'pid-absent' },
          operation: { callerKey: 'client-1', operationId: operationId(), fingerprint: 'fp-2' }
        })
      )
    ).rejects.toThrow('agent_session_conflict')
  })

  it('releases a conflict whose named owner is proven gone at restart', async () => {
    // A conflict with no exit is a session the user can never open again; present-time proof that
    // the process the conflict names has exited leaves no claimant left to protect.
    const first = await open()
    await establishOwner(first)
    await first.markClaimConflicted('session-alpha', NOW)

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
    expect(reopened.listOperationRows()).toHaveLength(1)
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

describe('orphans, claim keys, checkpoints, and unreadable rows', () => {
  it('calls a spawn token with no lease an orphan', async () => {
    const store = await open()
    await establishOwner(store)
    expect(store.listOrphanSpawnTokens(['spawn-a', 'spawn-z'])).toEqual(['spawn-z'])
  })

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

  it('refuses a journal checkpoint that moves backwards', async () => {
    const store = await open()
    await establishOwner(store)
    await store.setJournalCheckpoint({
      sessionId: 'session-alpha',
      fence: 1,
      checkpoint: { epoch: 2, sequence: 10 },
      now: NOW
    })
    await expect(
      store.setJournalCheckpoint({
        sessionId: 'session-alpha',
        fence: 1,
        checkpoint: { epoch: 2, sequence: 9 },
        now: NOW
      })
    ).rejects.toThrow('agent_session_checkpoint_stale')
    await expect(
      store.setJournalCheckpoint({
        sessionId: 'session-alpha',
        fence: 1,
        checkpoint: { epoch: 1, sequence: 999 },
        now: NOW
      })
    ).rejects.toThrow('agent_session_checkpoint_stale')
    const advanced = await store.setJournalCheckpoint({
      sessionId: 'session-alpha',
      fence: 1,
      checkpoint: { epoch: 3, sequence: 0 },
      now: NOW
    })
    expect(advanced.lease.journalCheckpoint).toEqual({ epoch: 3, sequence: 0 })
  })

  it('rejects a handoff stage change under a different operation id', async () => {
    const store = await open()
    await establishOwner(store)
    await setStoredAgentSessionHandoffStage(store, {
      sessionId: 'session-alpha',
      fence: 1,
      stage: 'preparing',
      handoffOperationId: 'op-1',
      now: NOW
    })
    await expect(
      setStoredAgentSessionHandoffStage(store, {
        sessionId: 'session-alpha',
        fence: 1,
        stage: 'old-owner-stopped',
        handoffOperationId: 'op-2',
        now: NOW
      })
    ).rejects.toThrow('agent_session_operation_conflict')
  })

  it.each([
    [
      'invalid checkpoint',
      (record: AgentSessionRecord) =>
        Object.assign(record.lease, { journalCheckpoint: { epoch: 'bad', sequence: 1 } })
    ],
    [
      'missing live proof',
      (record: AgentSessionRecord) => Object.assign(record.lease, { provenHandleLinkId: null })
    ]
  ])('quarantines a record with %s', async (_name, corrupt) => {
    const first = await open()
    await establishOwner(first)
    const filePath = agentSessionStorePath(directory)
    const raw = JSON.parse(await readFile(filePath, 'utf-8'))
    corrupt(raw.records['session-alpha'])
    await writeFile(filePath, JSON.stringify(raw))
    expect((await open()).isSessionUnreadable('session-alpha')).toBe(true)
  })

  it('recovers the previous committed state when the primary file is corrupt', async () => {
    const first = await open()
    await establishOwner(first)
    // A second commit leaves the first as the backup.
    await first.setJournalCheckpoint({
      sessionId: 'session-alpha',
      fence: 1,
      checkpoint: { epoch: 1, sequence: 1 },
      now: NOW
    })
    await writeFile(join(directory, AGENT_SESSION_STORE_FILE_NAME), '{ truncated')

    const reopened = await open()
    expect(reopened.recoveredFromBackup).toBe(true)
    expect(reopened.getRecord('session-alpha')?.lease.runtimeFence).toBe(1)

    // The next transaction completes. It used to reject forever: the latch that guarded against
    // the lost commit's fence had no exit, so a profile in this state could never write again.
    await expect(reopened.retireClaimKey('key-2', NOW)).resolves.not.toThrow()
    // Safety is kept by recording a FLOOR the next grant must clear, not by rewriting the current
    // fence: `live` means a handle proven at exactly that number, so moving it would invalidate the
    // record. The floor dominates the highest fence the lost commit could have granted (1 + 1).
    const recovered = reopened.getRecord('session-alpha')
    expect(recovered?.lease.runtimeFence).toBe(1)
    expect(recovered?.lease.minimumNextFence).toBe(3)
  })

  it.each([
    ['corrupt', ['{ truncated']],
    ['missing required collections', ['{"schemaVersion":1,"hostId":"local"}']],
    ['invalid operation row', [BAD_OP_STORE]],
    ['invalid retired key', [BAD_KEY_STORE]],
    ['corrupt in both committed copies', ['{ truncated', '{ also truncated']]
  ])('fails closed when the store is %s', async (_name, copies) => {
    const filePath = agentSessionStorePath(directory)
    await writeFile(filePath, copies[0])
    if (copies[1]) {
      await writeFile(`${filePath}.bak`, copies[1])
    }
    await expect(open()).rejects.toThrow('agent_session_store_corrupt')
  })

  it('refuses to write a store written by a newer schema', async () => {
    const filePath = agentSessionStorePath(directory)
    await writeFile(
      filePath,
      JSON.stringify({ schemaVersion: 99, hostId: 'local', records: {}, operations: {} })
    )
    const store = await open()
    expect(store.readOnly).toBe(true)
    await expect(store.reserveOwner(reserveRequest())).rejects.toThrow(
      'agent_session_legacy_required'
    )
  })
})
