import { openTestChats } from './structured-agent-session-open-test-chats.test-support'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
// Real wedged record shapes must become acquirable while retaining conversation and provider history.
// Migration releases the lease; only operations needing the agent may spawn it.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import {
  evaluateAgentSessionAcquisition,
  type AgentSessionOwnerProbe
} from '../../../shared/agent-session-lease-adjudication'
import { activeStructuredAgentSessionTurnId } from '../../../shared/structured-agent-session-projection'
import type { AgentSessionStatusSummary } from '../../../shared/agent-session-wire'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import type {
  AgentSessionClaimStatus,
  AgentSessionProcessIdentity
} from '../../../shared/agent-session-record'
import type {
  PersistedAgentSessionHandoffStage,
  PersistedAgentSessionRecord,
  PersistedAgentSessionRuntimeKind
} from '../../../shared/agent-session-legacy-handoff-lease'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import {
  openTestAgentSessionRecordStore,
  seedTestAgentSessionRecordStore
} from '../../runtime/agent-session-record-store-test-harness'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import { openAgentSessionJournal } from '../agent-session-journal/journal-store-factory'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { JournalLifecycleBatchAppender } from '../agent-session-journal/journal-lifecycle-batch-appender'
import * as recoveryResolution from './structured-agent-session-recovery-resolution'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import type { StructuredAgentSessionHostDeps } from './structured-agent-session-host-types'
import {
  HOST_TEST_LOCATION as LOCATION,
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD,
  hostTestAttachParams,
  resetHostTestOperationIds
} from './structured-agent-session-host-test-data'
import {
  closeTestJournalHostDatabases,
  openTestJournalHostDatabase
} from '../agent-session-journal/journal-host-database-test-support'
import { createStructuredAgentSessionLogger } from './structured-agent-session-logger'
import {
  claudeProviderHandle,
  codexProviderHandle
} from '../../../shared/agent-session-provider-handle-encoding'
import { NO_STRUCTURED_AGENTS } from './structured-agent-session-adapter-router-test-support'

const CALLER = { callerKey: 'client-1' }
const DEAD_OWNER: AgentSessionProcessIdentity = {
  hostId: 'local',
  pid: 12_546,
  processStartTimeMs: 1_786_772_085_000,
  spawnToken: 'spawn-dead'
}

let root: string
let store: AgentSessionRecordStore
let host: StructuredAgentSessionHost
let acquire: Mock<StructuredAgentSessionAdapter['acquire']>

type WedgeOverrides = {
  claimStatus: AgentSessionClaimStatus
  handoffStage: PersistedAgentSessionHandoffStage | null
  runtimeKind?: PersistedAgentSessionRuntimeKind
  ownerProcess?: AgentSessionProcessIdentity | null
  reservedSpawnToken?: string | null
  handoffOperationId?: string | null
}

function wedgedRecord(overrides: WedgeOverrides): PersistedAgentSessionRecord {
  const fence = 13
  return {
    schemaVersion: 2,
    sessionId: SESSION,
    location: LOCATION,
    provider: 'codex',
    providerHandleChain: [
      {
        linkId: `codex-${fence}-link`,
        handle: { provider: 'codex', threadId: THREAD },
        origin: 'created',
        mintedAtFence: fence,
        observedAt: NOW - 10_000
      }
    ],
    accountHome: { variable: 'CODEX_HOME', path: '/home/dev/.codex' },
    createdAt: NOW - 100_000,
    updatedAt: NOW - 10_000,
    lease: {
      sessionId: SESSION,
      runtimeKind: overrides.runtimeKind ?? 'native',
      runtimeFence: fence,
      handoffStage: overrides.handoffStage,
      provenHandleLinkId: `codex-${fence}-link`,
      ownerProcess: overrides.ownerProcess ?? null,
      reservedSpawnToken: overrides.reservedSpawnToken ?? null,
      leaseDeadlineAt: NOW - 9_000,
      lastRenewedAt: NOW - 10_000,
      handoffOperationId: overrides.handoffOperationId ?? null,
      claimKeyId: 'key-1',
      claimStatus: overrides.claimStatus,
      unreconciled: false,
      deathEvidence: null
    }
  }
}

async function seedStore(record: PersistedAgentSessionRecord): Promise<void> {
  await seedTestAgentSessionRecordStore(root, { records: [record] })
  store = await openTestAgentSessionRecordStore(root, { legacySessionTabIds: [SESSION] })
}

function openHost(overrides: Partial<StructuredAgentSessionHostDeps> = {}): void {
  host = new StructuredAgentSessionHost({
    agents: NO_STRUCTURED_AGENTS,
    logger: createStructuredAgentSessionLogger(),
    store,
    adapter: {
      open: async () => ({
        reportedOptions: { model: '' }
      }),
      acquire,
      releaseAcquisition: vi.fn(async () => false),
      dispatch: vi.fn(),
      cancelTurn: vi.fn(),
      answerPrompt: vi.fn(),
      setOption: vi.fn(),
      supportsCreate: () => true
    },
    journalDatabase: openTestJournalHostDatabase(root),
    claimKeyId: 'key-1',
    mintSpawnToken: () => 'spawn-new',
    now: () => NOW,
    probeOwner: async () => ({ outcome: 'pid-absent' }),
    ...overrides
  })
}

function startAgent(): Promise<unknown> {
  const context = host['mutationContext']()
  return context
    .serialize(SESSION, async () => context.claimAgent(SESSION))
    .then((claim) => claim.outcome)
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-wedged-profile-'))
  resetHostTestOperationIds()
  acquire = vi.fn(async ({ fence }) => ({
    acquisitionGeneration: globalThis.crypto.randomUUID(),
    process: {
      hostId: 'local',
      pid: 4242,
      processStartTimeMs: 1_700_000_000_000,
      spawnToken: store.getRecord(SESSION)?.lease.reservedSpawnToken ?? 'spawn-new'
    },
    link: {
      linkId: `link-${fence}`,
      handle: codexProviderHandle(THREAD),
      origin: 'resumed' as const,
      mintedAtFence: fence,
      observedAt: NOW
    }
  }))
})

afterEach(async () => {
  await host?.flushAllStreamedEvents()
  await closeTestJournalHostDatabases()
  await rm(root, { recursive: true, force: true })
})

function isAcquirable(lease: NonNullable<ReturnType<typeof store.getRecord>>['lease']): boolean {
  return (
    evaluateAgentSessionAcquisition({
      lease,
      expectedFence: lease.runtimeFence,
      handoffOperationId: null,
      probe: { outcome: 'reservation-unused' }
    }).decision === 'granted'
  )
}

// Start after last renewal so death proof cannot end the turn before it began.
const SEEDED_TURN_STARTED_AT = NOW - 5_000

async function seedRunningTurn(provider: 'codex' | 'claude' = 'codex'): Promise<void> {
  const journal = await openAgentSessionJournal({
    identity: {
      sessionId: SESSION,
      workspaceId: LOCATION.workspaceId,
      hostId: LOCATION.executionHostId,
      agent: provider,
      providerHandle:
        provider === 'codex'
          ? codexProviderHandle(THREAD)
          : claudeProviderHandle('provider-session-alpha-1', null)
    },
    database: openTestJournalHostDatabase(root)
  })
  await journal.appendItem(
    provider === 'codex'
      ? { provider: 'codex', threadId: THREAD, turnId: 'turn-1', ordinal: 0 }
      : { provider: 'claude', sessionId: 'provider-session-alpha-1', uuid: 'uuid-running' },
    { kind: 'turn', turnId: 'turn-1', state: 'running', startedAt: SEEDED_TURN_STARTED_AT },
    { fence: 13, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
  await journal.close()
}

function turnLifecycle(turnId: string) {
  const item = restoredJournal()
    .snapshot()
    .items.find((candidate) => readAgentJournalTurn(candidate.body)?.turnId === turnId)
  return item ? { ...readAgentJournalTurn(item.body), recovered: item.recovered } : null
}

function restoredJournal(): AgentSessionJournal {
  const restored = (
    host as unknown as { sessions: Map<string, { journal: AgentSessionJournal }> }
  ).sessions.get(SESSION)
  if (!restored) {
    throw new Error('expected a restored session journal')
  }
  return restored.journal
}

describe('already-wedged profiles become usable on load', () => {
  it.each(['codex', 'claude'] as const)(
    'settles a wedged %s journal on boot without opening a provider child',
    async (provider) => {
      const record = wedgedRecord({
        claimStatus: 'live',
        handoffStage: null,
        ownerProcess: DEAD_OWNER
      })
      const providerRecord: PersistedAgentSessionRecord =
        provider === 'codex'
          ? record
          : {
              ...record,
              provider: 'claude',
              accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: '/home/dev/.claude' },
              lease: { ...record.lease, provenHandleLinkId: 'claude-13-link' },
              providerHandleChain: [
                {
                  linkId: 'claude-13-link',
                  handle: {
                    provider: 'claude',
                    sessionId: 'provider-session-alpha-1',
                    leafUuid: null
                  },
                  origin: 'created',
                  mintedAtFence: 13,
                  observedAt: NOW - 10_000
                }
              ]
            }
      await seedStore(providerRecord)
      await seedRunningTurn(provider)
      openHost()

      await openTestChats(host)

      expect(host.hasSession(SESSION)).toBe(true)
      const firstCursor = restoredJournal().cursor()
      expect(activeStructuredAgentSessionTurnId(restoredJournal().snapshot().items)).toBe(null)
      expect(store.getRecord(SESSION)?.lease).toMatchObject({
        claimStatus: 'released',
        handoffStage: null
      })
      expect(acquire).not.toHaveBeenCalled()

      await host.flushAllStreamedEvents()
      store = await openTestAgentSessionRecordStore(root, { legacySessionTabIds: [SESSION] })
      openHost()
      await openTestChats(host)

      expect(restoredJournal().cursor()).toEqual(firstCursor)
      expect(activeStructuredAgentSessionTurnId(restoredJournal().snapshot().items)).toBe(null)
    }
  )

  it.each([
    [
      'an exit the host saw but could not settle before quitting',
      wedgedRecord({ claimStatus: 'released', handoffStage: null }),
      {
        kind: 'exit-observed',
        detail: 'provider exited: transport closed',
        observedAt: NOW - 1_000
      } as const,
      { state: 'interrupted', completedAt: NOW - 1_000 }
    ],
    [
      'a quit that left the owner for a probe to prove gone',
      wedgedRecord({ claimStatus: 'live', handoffStage: null, ownerProcess: DEAD_OWNER }),
      null,
      { state: 'interrupted', completedAt: SEEDED_TURN_STARTED_AT }
    ],
    [
      'a quit that left an owner on a host this one cannot probe',
      wedgedRecord({
        claimStatus: 'live',
        handoffStage: null,
        ownerProcess: { ...DEAD_OWNER, hostId: 'remote-host' }
      }),
      null,
      { state: 'unverifiable' }
    ]
  ] as const)(
    'reopens a chat that was mid-turn at %s with nothing running and no working status',
    async (_quit, seeded, deathEvidence, verdict) => {
      await seedStore({ ...seeded, lease: { ...seeded.lease, deathEvidence } })
      await seedRunningTurn()
      const published: AgentSessionStatusSummary[] = []
      const remote = seeded.lease.ownerProcess?.hostId === 'remote-host'
      openHost({
        statusSink: { publish: (summary) => published.push(summary), forget: () => {} },
        // Remote contact loss proves no death; probing stays indeterminate.
        ...(remote
          ? {
              probeOwner: async () => ({
                outcome: 'indeterminate' as const,
                reason: 'owner runs on remote-host, which this host cannot probe'
              })
            }
          : {})
      })

      await openTestChats(host)

      expect(acquire).not.toHaveBeenCalled()
      expect(turnLifecycle('turn-1')).toEqual({
        turnId: 'turn-1',
        startedAt: NOW - 5_000,
        recovered: true,
        ...verdict
      })
      expect(activeStructuredAgentSessionTurnId(restoredJournal().snapshot().items)).toBe(null)
      const statusRows = restoredJournal()
        .snapshot()
        .items.flatMap((item) => (item.body.kind === 'status' ? [item.body.text] : []))
      expect(statusRows).toEqual(
        remote
          ? []
          : [
              'Codex stopped while this response was in progress. You can continue in this conversation.'
            ]
      )
      expect(published.filter((summary) => summary.sessionId === SESSION)).not.toEqual([])
      expect(published.map((summary) => summary.status)).not.toContain('working')
      // Crash evidence must never become a user-attributed cancellation.
      expect(published[0]?.turnOutcome).toBeUndefined() // Legacy list is neutral until opened.
      expect(published.at(-1)?.turnOutcome).toBe(
        verdict.state === 'interrupted' ? 'interruption' : 'unconfirmed'
      )
    }
  )

  it('settles restart eviction through attach when a start arrives before the boot sweep', async () => {
    await seedStore(
      wedgedRecord({ claimStatus: 'live', handoffStage: null, ownerProcess: DEAD_OWNER })
    )
    await seedRunningTurn()
    openHost()

    // Adjudication advances the fence; retry attach at the returned fence.
    const stale = await host.attach(CALLER, hostTestAttachParams(13))
    const fence = stale.ok ? 13 : (stale.refusal.currentFence ?? 13)
    expect(stale.ok || stale.refusal.code === 'agent_session_checkpoint_stale').toBe(true)
    expect(stale.ok || (await host.attach(CALLER, hostTestAttachParams(fence))).ok).toBe(true)

    expect(acquire).toHaveBeenCalledOnce()
    expect(activeStructuredAgentSessionTurnId(restoredJournal().snapshot().items)).toBe(null)
    expect(turnLifecycle('turn-1')).toEqual({
      turnId: 'turn-1',
      state: 'interrupted',
      startedAt: NOW - 5_000,
      completedAt: SEEDED_TURN_STARTED_AT,
      recovered: true
    })
    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      claimStatus: 'live',
      handoffStage: null
    })
  })

  it('settles an observed-exit latch through attach before the boot sweep', async () => {
    const record = wedgedRecord({ claimStatus: 'released', handoffStage: 'recovering' })
    // Legacy persisted latch, now derived instead of stored.
    const olderBuildLatch = {
      settlementRetryRequired: true,
      settlementRetryId: `provider-exit:${SESSION}:12:generation-1`
    }
    record.lease = {
      ...record.lease,
      ...olderBuildLatch,
      deathEvidence: {
        kind: 'exit-observed',
        detail: 'provider exited: transport closed',
        observedAt: NOW - 1_000
      }
    }
    await seedStore(record)
    await seedRunningTurn()
    openHost()

    expect(await host.attach(CALLER, hostTestAttachParams(13))).toMatchObject({ ok: true })

    expect(acquire).toHaveBeenCalledOnce()
    expect(activeStructuredAgentSessionTurnId(restoredJournal().snapshot().items)).toBe(null)
    expect(turnLifecycle('turn-1')).toEqual({
      turnId: 'turn-1',
      state: 'interrupted',
      startedAt: NOW - 5_000,
      completedAt: NOW - 1_000,
      recovered: true
    })
    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      claimStatus: 'live',
      handoffStage: null
    })
    expect(store.getRecord(SESSION)?.lease).not.toHaveProperty('settlementRetryRequired')
    expect(store.getRecord(SESSION)?.lease).not.toHaveProperty('settlementRetryId')
  })

  it.each([
    ['a restart eviction', false],
    ['a proven eviction by recovery', true]
  ] as const)(
    'settles the turn %s left at the next acquire when the read restore could not write it',
    async (_origin, ownerOutlivedRestart) => {
      await seedStore(
        wedgedRecord({ claimStatus: 'live', handoffStage: null, ownerProcess: DEAD_OWNER })
      )
      await seedRunningTurn()
      let ownerAlive = ownerOutlivedRestart
      const stopOwnerProcess = vi.fn(() => {
        ownerAlive = false
      })
      openHost({
        probeOwner: async () =>
          ownerAlive
            ? { outcome: 'identity-matched', matchedOn: ['spawn-token'] }
            : { outcome: 'pid-absent' },
        stopOwnerProcess
      })
      const failing = vi
        .spyOn(JournalLifecycleBatchAppender.prototype, 'appendPlanned')
        .mockRejectedValue(new Error('journal unavailable'))
      await openTestChats(host)
      failing.mockRestore()
      expect(activeStructuredAgentSessionTurnId(restoredJournal().snapshot().items)).toBe('turn-1')
      expect(stopOwnerProcess).toHaveBeenCalledTimes(ownerOutlivedRestart ? 1 : 0)
      expect(store.getRecord(SESSION)?.lease).toMatchObject({
        claimStatus: 'released',
        handoffStage: null,
        deathEvidence: { kind: 'pid-absent' }
      })

      await startAgent()

      expect(acquire).toHaveBeenCalledOnce()
      expect(store.getRecord(SESSION)?.lease).toMatchObject({ claimStatus: 'live' })
      expect(turnLifecycle('turn-1')).toEqual({
        turnId: 'turn-1',
        state: 'interrupted',
        startedAt: NOW - 5_000,
        completedAt: SEEDED_TURN_STARTED_AT,
        recovered: true
      })
    }
  )

  it('releases an owner that survives every stop signal, and the chat starts again', async () => {
    await seedStore(
      wedgedRecord({ claimStatus: 'live', handoffStage: null, ownerProcess: DEAD_OWNER })
    )
    const stopOwnerProcess = vi.fn()
    openHost({
      probeOwner: async () => ({ outcome: 'identity-matched', matchedOn: ['spawn-token'] }),
      stopOwnerProcess
    })

    const resolveRecovery = recoveryResolution.resolveStructuredSessionRecovery
    const recovery = vi
      .spyOn(recoveryResolution, 'resolveStructuredSessionRecovery')
      .mockImplementation((deps, sessionId) =>
        resolveRecovery({ ...deps, delay: async () => {} }, sessionId)
      )
    try {
      await openTestChats(host)
    } finally {
      recovery.mockRestore()
    }

    expect(stopOwnerProcess.mock.calls).toEqual([
      [DEAD_OWNER.pid, 'SIGTERM'],
      [DEAD_OWNER.pid, 'SIGKILL']
    ])
    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      claimStatus: 'released',
      handoffStage: null,
      ownerProcess: null,
      deathEvidence: null
    })
    expect(await host.attach(CALLER, hostTestAttachParams(14))).toMatchObject({ ok: true })
    expect(acquire).toHaveBeenCalledOnce()
  })

  it.each([
    ['a conflicted claim naming no process', { claimStatus: 'conflicted', ownerProcess: null }],
    [
      'an unproven reservation left in manual recovery',
      { claimStatus: 'reserved', ownerProcess: null, reservedSpawnToken: 'spawn-lost' }
    ]
  ] as const)(
    'releases %s an older build left, and the chat starts again',
    async (_legacyRecord, lease) => {
      await seedStore(wedgedRecord({ handoffStage: 'manual-recovery', ...lease }))
      openHost({ probeOwner: async () => ({ outcome: 'indeterminate', reason: 'no scan here' }) })

      await openTestChats(host)

      expect(store.getRecord(SESSION)?.lease).toMatchObject({
        claimStatus: 'released',
        handoffStage: null,
        runtimeFence: 14,
        deathEvidence: null
      })
      expect(await host.attach(CALLER, hostTestAttachParams(14))).toMatchObject({ ok: true })
      expect(acquire).toHaveBeenCalledOnce()
    }
  )

  it('interrupts a running turn left behind by a released lease on a cold acquire', async () => {
    // No exit was observed; a replaced generation with no later liveness evidence still needs settlement.
    await seedStore(wedgedRecord({ claimStatus: 'released', handoffStage: null }))
    await seedRunningTurn()
    openHost()

    expect(await host.attach(CALLER, hostTestAttachParams(13))).toMatchObject({ ok: true })

    expect(acquire).toHaveBeenCalledOnce()
    expect(turnLifecycle('turn-1')).toEqual({
      turnId: 'turn-1',
      state: 'interrupted',
      startedAt: NOW - 5_000,
      completedAt: NOW - 5_000,
      recovered: true
    })
    expect(
      restoredJournal()
        .snapshot()
        .items.some(
          (item) => item.body.kind === 'status' && item.body.text.startsWith('Provider exited')
        )
    ).toBe(false)
  })

  it("leaves the live generation's running turn alone on a re-attach", async () => {
    await seedStore(wedgedRecord({ claimStatus: 'released', handoffStage: null }))
    openHost({
      probeOwner: async () => ({ outcome: 'identity-matched', matchedOn: ['spawn-token'] })
    })
    const params = hostTestAttachParams(13)
    expect(await host.attach(CALLER, params)).toMatchObject({ ok: true })
    const fence = store.getRecord(SESSION)!.lease.runtimeFence
    await restoredJournal().appendItem(
      { provider: 'codex', threadId: THREAD, turnId: 'turn-2', ordinal: 0 },
      { kind: 'turn', turnId: 'turn-2', state: 'running', startedAt: NOW },
      { fence, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )

    expect(await host.attach(CALLER, params)).toMatchObject({ ok: true, replayed: true })

    expect(acquire).toHaveBeenCalledOnce()
    expect(turnLifecycle('turn-2')).toEqual({ turnId: 'turn-2', state: 'running', startedAt: NOW })
  })

  it('re-adjudicates a conflicted manual-recovery record whose owner is provably gone', async () => {
    await seedStore(
      wedgedRecord({
        claimStatus: 'conflicted',
        handoffStage: 'manual-recovery',
        ownerProcess: DEAD_OWNER
      })
    )
    openHost()

    await openTestChats(host)

    const lease = store.getRecord(SESSION)!.lease
    expect(lease).toMatchObject({ handoffStage: null, unreconciled: false })
    expect(isAcquirable(lease)).toBe(true)
    expect(lease?.runtimeFence).toBeGreaterThan(13)
    expect(store.getRecord(SESSION)?.providerHandleChain[0]).toMatchObject({
      linkId: 'codex-13-link',
      handle: { nativeId: THREAD }
    })
    // Migration only unlatches; acquiring here would spawn idle agents at every startup.
    expect(acquire).not.toHaveBeenCalled()
  })

  it('unlatches a released record that reloaded into recovery with nothing outstanding', async () => {
    // An ownerless released lease has nothing to probe; treating it as unproven relatches every boot.
    await seedStore(wedgedRecord({ claimStatus: 'released', handoffStage: 'recovering' }))
    openHost()

    await openTestChats(host)

    const lease = store.getRecord(SESSION)!.lease
    expect(lease).toMatchObject({ handoffStage: null, unreconciled: false })
    expect(isAcquirable(lease)).toBe(true)
  })

  it('exits a TUI reservation an older build left before its identity was committed', async () => {
    // TUI crashed before commitProcessIdentity; only recovery resolution can release its ownerless reservation.
    await seedStore(
      wedgedRecord({
        claimStatus: 'reserved',
        handoffStage: 'new-owner-proving',
        runtimeKind: 'tui',
        reservedSpawnToken: 'spawn-tui',
        handoffOperationId: 'handoff-op-1'
      })
    )
    // Restart cannot enumerate the token yet; the later recovery pass can.
    let probes = 0
    openHost({
      probeOwner: async () => {
        probes += 1
        return probes === 1
          ? { outcome: 'indeterminate', reason: 'host could not enumerate spawn tokens' }
          : { outcome: 'reservation-unused' }
      }
    })

    await openTestChats(host)

    const lease = store.getRecord(SESSION)!.lease
    expect(lease).toMatchObject({ handoffStage: null, unreconciled: false })
    expect(isAcquirable(lease)).toBe(true)
  })

  it('does not infer orphan ownership from a host-global token scan', async () => {
    await seedStore(
      wedgedRecord({
        claimStatus: 'conflicted',
        handoffStage: 'manual-recovery',
        ownerProcess: DEAD_OWNER
      })
    )
    const order: string[] = []
    const scan = vi.fn(
      async () =>
        new Map([
          ['spawn-lost', [31_337]],
          [DEAD_OWNER.spawnToken, [12_546]]
        ])
    )
    acquire.mockImplementation(async ({ fence }) => {
      order.push('acquire')
      return {
        acquisitionGeneration: globalThis.crypto.randomUUID(),
        process: { hostId: 'local', pid: 4242, processStartTimeMs: 1, spawnToken: 'spawn-new' },
        link: {
          linkId: `link-${fence}`,
          handle: codexProviderHandle(THREAD),
          origin: 'resumed' as const,
          mintedAtFence: fence,
          observedAt: NOW
        }
      }
    })
    openHost({
      scanSpawnTokenProcesses: scan,
      stopOwnerProcess: (pid) => order.push(`stop:${pid}`)
    })

    await openTestChats(host)
    expect(order).toEqual([])
    expect(scan).not.toHaveBeenCalled()
    const fence = store.getRecord(SESSION)?.lease.runtimeFence ?? null
    expect(await host.attach(CALLER, hostTestAttachParams(fence))).toMatchObject({ ok: true })

    expect(order).toEqual(['acquire'])
  })

  it('waits out a conflicted owner it cannot verify, signalling nothing, until it is proven gone', async () => {
    await seedStore(
      wedgedRecord({
        claimStatus: 'conflicted',
        handoffStage: 'manual-recovery',
        ownerProcess: DEAD_OWNER
      })
    )
    const stopOwnerProcess = vi.fn()
    let probe: AgentSessionOwnerProbe = { outcome: 'indeterminate', reason: 'no answer' }
    openHost({ probeOwner: async () => probe, stopOwnerProcess })
    await openTestChats(host)

    // An unanswered probe cannot authorize takeover of a TUI transport surviving restart.
    const fence = store.getRecord(SESSION)?.lease.runtimeFence ?? null
    expect(await host.attach(CALLER, hostTestAttachParams(fence))).toMatchObject({
      ok: false,
      refusal: { code: 'agent_session_conflict' }
    })
    expect(acquire).not.toHaveBeenCalled()

    probe = { outcome: 'pid-absent' }
    await startAgent()
    expect(acquire).toHaveBeenCalledOnce()
    expect(stopOwnerProcess).not.toHaveBeenCalled()
  })
})
