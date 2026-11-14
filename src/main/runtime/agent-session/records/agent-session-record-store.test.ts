import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentSessionOwnerProbe } from '../../../../shared/agent-session/lifecycle/leases/agent-session-lease-adjudication'
import type {
  AgentSessionExecutionLocation,
  AgentSessionProcessIdentity,
  AgentSessionRecord
} from '../../../../shared/agent-session/lifecycle/agent-session-record'
import type { AgentSessionProviderHandleLink } from '../../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle'
import type { AgentSessionRecordStore } from './agent-session-record-store'
import {
  openTestAgentSessionRecordStore,
  readPersistedTestAgentSessionStore
} from './agent-session-record-store-test-harness'
import {
  closeTestJournalHostDatabases,
  openTestJournalHostDatabase
} from '../../../native-chat/agent-session-journal/store-lifecycle/journal-host-database-test-support'
import type { AgentSessionReserveRequest } from '../ownership/agent-session-reservation-admission'
import {
  claudeProviderHandle,
  codexProviderHandle
} from '../../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'

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
  await closeTestJournalHostDatabases()
  await rm(directory, { recursive: true, force: true })
})

describe('acquisition path', () => {
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
  it('grants exactly one of two concurrent reservations at the next fence', async () => {
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

  it('never keeps a change in memory that failed to commit to disk', async () => {
    const store = await open()
    await establishOwner(store)
    const before = store.getRecord('session-alpha')
    const persistedBefore = await readPersistedTestAgentSessionStore(directory)
    // Fail the record update inside commit, like full-disk/I/O failure.
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

    const evicted = await store.evictProvenDeadOwner({
      sessionId: 'session-alpha',
      expectedFence: 1,
      probe: { outcome: 'pid-absent' },
      now: wellPastDeadline
    })
    expect(evicted.lease).toMatchObject({ runtimeFence: 2, claimStatus: 'released' })
    expect(evicted.lease.deathEvidence?.kind).toBe('pid-absent')
  })
})

describe('restart reconciliation', () => {
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
})
