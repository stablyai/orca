// The profiles already shipped into a dead end.
//
// Every record here is a shape taken from a real wedged store: a lease that no acquisition, no
// handoff restore, and no manual recovery can move, so the chat behind it never opens again. The
// contract is that loading the record under this build makes it usable WITHOUT losing the
// conversation — the journal, the provider handle chain, and the recorded evidence all survive.
//
// "Usable" means ACQUIRABLE, not acquired. Startup no longer resumes a provider child for a record
// nobody is looking at; a surface taking a hold is what spawns one. So the migration's job is to
// leave the lease in a state a hold can claim, and these tests prove that by adjudicating it rather
// than by reading fields off it.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { evaluateAgentSessionAcquisition } from '../../../shared/agent-session-lease-adjudication'
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
import { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { AGENT_SESSION_STORE_FILE_NAME } from '../../runtime/agent-session-record-store-file'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import { openAgentSessionJournal } from '../agent-session-journal/journal-store-factory'
import { journalDirectoryFor } from '../agent-session-journal/journal-paths'
import { AgentSessionJournal } from '../agent-session-journal/journal-store'
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

/** A record in the wedged shape, as a build may have left it on disk, with real history behind it. */
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
      journalCheckpoint: null,
      claimKeyId: 'key-1',
      claimStatus: overrides.claimStatus,
      unreconciled: false,
      deathEvidence: null
    }
  }
}

async function seedStore(record: PersistedAgentSessionRecord): Promise<void> {
  const directory = join(root, 'store')
  await mkdir(directory, { recursive: true })
  await writeFile(
    join(directory, AGENT_SESSION_STORE_FILE_NAME),
    JSON.stringify({
      schemaVersion: 2,
      hostId: 'local',
      records: { [record.sessionId]: record },
      operations: {},
      retiredClaimKeys: [],
      unusableRecords: {}
    }),
    'utf-8'
  )
  store = await AgentSessionRecordStore.open({ directory, hostId: 'local' })
}

/** Every recorded owner in these fixtures is long gone; that is the present-time evidence. */
function openHost(overrides: Partial<StructuredAgentSessionHostDeps> = {}): void {
  host = new StructuredAgentSessionHost({
    store,
    adapter: {
      acquire,
      releaseAcquisition: vi.fn(async () => undefined),
      dispatch: vi.fn(),
      cancelTurn: vi.fn(),
      answerPrompt: vi.fn(),
      setOption: vi.fn(),
      supportsCreate: () => true
    } as unknown as StructuredAgentSessionAdapter,
    journalRoot: root,
    claimKeyId: 'key-1',
    mintSpawnToken: () => 'spawn-new',
    now: () => NOW,
    probeOwner: async () => ({ outcome: 'pid-absent' }),
    ...overrides
  })
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-wedged-profile-'))
  resetHostTestOperationIds()
  acquire = vi.fn(async ({ fence }) => ({
    process: {
      hostId: 'local',
      pid: 4242,
      processStartTimeMs: 1_700_000_000_000,
      spawnToken: store.getRecord(SESSION)?.lease.reservedSpawnToken ?? 'spawn-new'
    },
    link: {
      linkId: `link-${fence}`,
      handle: { provider: 'codex', threadId: THREAD },
      origin: 'resumed' as const,
      mintedAtFence: fence,
      observedAt: NOW
    }
  }))
})

afterEach(async () => {
  await host?.flushAllStreamedEvents()
  await rm(root, { recursive: true, force: true })
})

/** The property that matters: a hold taken now would be granted a lease. */
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

async function seedRunningTurn(provider: 'codex' | 'claude' = 'codex'): Promise<void> {
  const journal = await openAgentSessionJournal({
    identity: {
      sessionId: SESSION,
      workspaceId: LOCATION.workspaceId,
      hostId: LOCATION.executionHostId,
      agent: provider,
      providerHandle:
        provider === 'codex'
          ? { kind: 'codex', threadId: THREAD }
          : { kind: 'claude', sessionId: 'provider-session-alpha-1', leafUuid: null }
    },
    journalDir: journalDirectoryFor(root, { workspaceId: LOCATION.workspaceId, sessionId: SESSION })
  })
  await journal.appendItem(
    provider === 'codex'
      ? { provider: 'codex', threadId: THREAD, turnId: 'turn-1', ordinal: 0 }
      : { provider: 'claude', sessionId: 'provider-session-alpha-1', uuid: 'uuid-running' },
    { kind: 'turn', turnId: 'turn-1', state: 'running', startedAt: NOW - 5_000 },
    { fence: 13 }
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

      await host.restoreReadableSessions()

      expect(host.hasSession(SESSION)).toBe(true)
      const firstCursor = restoredJournal().cursor()
      expect(activeStructuredAgentSessionTurnId(restoredJournal().snapshot().items)).toBe(null)
      expect(store.getRecord(SESSION)?.lease).toMatchObject({
        claimStatus: 'released',
        handoffStage: null
      })
      expect(acquire).not.toHaveBeenCalled()

      await host.flushAllStreamedEvents()
      store = await AgentSessionRecordStore.open({
        directory: join(root, 'store'),
        hostId: 'local'
      })
      openHost()
      await host.restoreReadableSessions()

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
      { state: 'unverifiable' }
    ]
  ] as const)(
    'reopens a chat that was mid-turn at %s with nothing running and no working status',
    async (_quit, seeded, deathEvidence, verdict) => {
      await seedStore({ ...seeded, lease: { ...seeded.lease, deathEvidence } })
      await seedRunningTurn()
      const published: AgentSessionStatusSummary[] = []
      openHost({
        statusSink: { publish: (summary) => published.push(summary), forget: () => {} }
      })

      await host.restoreReadableSessions()

      expect(acquire).not.toHaveBeenCalled()
      expect(turnLifecycle('turn-1')).toEqual({
        turnId: 'turn-1',
        startedAt: NOW - 5_000,
        recovered: true,
        ...verdict
      })
      expect(activeStructuredAgentSessionTurnId(restoredJournal().snapshot().items)).toBe(null)
      // What the sidebar reads: every status this restart published says the chat is not working.
      expect(published.filter((summary) => summary.sessionId === SESSION)).not.toEqual([])
      expect(published.map((summary) => summary.status)).not.toContain('working')
    }
  )

  it('settles restart eviction through attach when a hold arrives before the boot sweep', async () => {
    await seedStore(
      wedgedRecord({ claimStatus: 'live', handoffStage: null, ownerProcess: DEAD_OWNER })
    )
    await seedRunningTurn()
    openHost()

    await host.hold(SESSION, 'desktop-chat:restart')

    expect(acquire).toHaveBeenCalledOnce()
    expect(activeStructuredAgentSessionTurnId(restoredJournal().snapshot().items)).toBe(null)
    // A pid probe proved the owner gone; nobody saw it exit, so the turn has no end.
    expect(turnLifecycle('turn-1')).toEqual({
      turnId: 'turn-1',
      state: 'unverifiable',
      startedAt: NOW - 5_000,
      recovered: true
    })
    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      claimStatus: 'live',
      handoffStage: null
    })
  })

  it('settles an observed-exit latch through attach before the boot sweep', async () => {
    const record = wedgedRecord({ claimStatus: 'released', handoffStage: 'recovering' })
    // The settlement latch an older build wrote; this build derives the settlement instead.
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
    // The exit was observed, so its receipt is the turn's end.
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
    // The older build's latch is dropped at load, so a downgrade never sees it again.
    expect(store.getRecord(SESSION)?.lease).not.toHaveProperty('settlementRetryRequired')
    expect(store.getRecord(SESSION)?.lease).not.toHaveProperty('settlementRetryId')
  })

  it.each([
    ['a restart eviction', false],
    ['a proven eviction by recovery', true]
  ] as const)(
    'settles the turn %s left even when the handle it was restored with never writes',
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
      // The read restore's settlement fails, and the handle it restored with never writes again.
      const failing = vi
        .spyOn(AgentSessionJournal.prototype, 'appendLifecycleBatch')
        .mockRejectedValue(new Error('journal unavailable'))
      await host.restoreReadableSessions()
      failing.mockRestore()
      vi.spyOn(restoredJournal(), 'appendLifecycleBatch').mockRejectedValue(
        new Error('journal unavailable')
      )
      expect(stopOwnerProcess).toHaveBeenCalledTimes(ownerOutlivedRestart ? 1 : 0)
      expect(store.getRecord(SESSION)?.lease).toMatchObject({
        claimStatus: 'released',
        handoffStage: null,
        deathEvidence: { kind: 'pid-absent' }
      })

      await host.hold(SESSION, 'desktop-chat:restart')

      expect(acquire).toHaveBeenCalledOnce()
      expect(store.getRecord(SESSION)?.lease).toMatchObject({ claimStatus: 'live' })
      // A pid probe proved the owner gone; nobody saw it exit, so the turn has no end.
      expect(turnLifecycle('turn-1')).toEqual({
        turnId: 'turn-1',
        state: 'unverifiable',
        startedAt: NOW - 5_000,
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

    await host.restoreReadableSessions()

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
    async (_shape, lease) => {
      await seedStore(wedgedRecord({ handoffStage: 'manual-recovery', ...lease }))
      openHost({ probeOwner: async () => ({ outcome: 'indeterminate', reason: 'no scan here' }) })

      await host.restoreReadableSessions()

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

  it('marks a running turn left behind by a released lease unverifiable on a cold acquire', async () => {
    // No settlement latch: the record was released cleanly, but the journal still says a turn is
    // running. The child that wrote it is gone and nothing observed its exit.
    await seedStore(wedgedRecord({ claimStatus: 'released', handoffStage: null }))
    await seedRunningTurn()
    openHost()

    expect(await host.attach(CALLER, hostTestAttachParams(13))).toMatchObject({ ok: true })

    expect(acquire).toHaveBeenCalledOnce()
    expect(turnLifecycle('turn-1')).toEqual({
      turnId: 'turn-1',
      state: 'unverifiable',
      startedAt: NOW - 5_000,
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
    // The child this host spawns stays provably alive across the second attach.
    openHost({
      probeOwner: async () => ({ outcome: 'identity-matched', matchedOn: ['spawn-token'] })
    })
    const params = hostTestAttachParams(13)
    expect(await host.attach(CALLER, params)).toMatchObject({ ok: true })
    const fence = store.getRecord(SESSION)!.lease.runtimeFence
    await restoredJournal().appendItem(
      { provider: 'codex', threadId: THREAD, turnId: 'turn-2', ordinal: 0 },
      { kind: 'turn', turnId: 'turn-2', state: 'running', startedAt: NOW },
      { fence }
    )

    // A reconnecting client replays its attach; the same operation admits the live owner.
    expect(await host.attach(CALLER, params)).toMatchObject({ ok: true, replayed: true })

    expect(acquire).toHaveBeenCalledOnce()
    expect(turnLifecycle('turn-2')).toEqual({ turnId: 'turn-2', state: 'running', startedAt: NOW })
  })

  it('re-adjudicates a conflicted manual-recovery record whose owner is provably gone', async () => {
    // A crash can leave a conflicted current-schema row in manual recovery; positive death proof
    // must make it acquirable again without discarding the provider handle.
    await seedStore(
      wedgedRecord({
        claimStatus: 'conflicted',
        handoffStage: 'manual-recovery',
        ownerProcess: DEAD_OWNER
      })
    )
    openHost()

    await host.restoreReadableSessions()

    const lease = store.getRecord(SESSION)!.lease
    expect(lease).toMatchObject({ handoffStage: null, unreconciled: false })
    expect(isAcquirable(lease)).toBe(true)
    // A real re-adjudication, not a no-op: the eviction minted a new generation.
    expect(lease?.runtimeFence).toBeGreaterThan(13)
    // The conversation survived: the codex thread was resumed, not recreated.
    expect(store.getRecord(SESSION)?.providerHandleChain[0]).toMatchObject({
      linkId: 'codex-13-link',
      handle: { threadId: THREAD }
    })
    // Why NOT acquired here: startup spawning a provider child for every recovered record is the
    // accumulation this stack removed. Unlatching is the migration's job; spawning is a hold's.
    expect(acquire).not.toHaveBeenCalled()
  })

  it('unlatches a released record that reloaded into recovery with nothing outstanding', async () => {
    // An evicted lease has no owner and no token, so a restart has nothing to probe. Treating that
    // as an unproven reservation re-latched it to `recovering` on every single boot.
    await seedStore(wedgedRecord({ claimStatus: 'released', handoffStage: 'recovering' }))
    openHost()

    await host.restoreReadableSessions()

    const lease = store.getRecord(SESSION)!.lease
    expect(lease).toMatchObject({ handoffStage: null, unreconciled: false })
    expect(isAcquirable(lease)).toBe(true)
  })

  it('exits a TUI reservation an older build left before its identity was committed', async () => {
    // The reviewer's shape: a TUI child launched, the runtime died before `commitProcessIdentity`,
    // and restart adjudication could not answer, so the lease latched at `recovering` with a null
    // owner. Handoff restore cannot help (no owner to talk to) and manual recovery requires one,
    // so recovery resolution is the ONLY exit — and it used to skip every TUI record.
    await seedStore(
      wedgedRecord({
        claimStatus: 'reserved',
        handoffStage: 'new-owner-proving',
        runtimeKind: 'tui',
        reservedSpawnToken: 'spawn-tui',
        handoffOperationId: 'handoff-op-1'
      })
    )
    // Restart adjudication runs while the host still cannot enumerate the token; the later
    // recovery pass gets a real answer.
    let probes = 0
    openHost({
      probeOwner: async () => {
        probes += 1
        return probes === 1
          ? { outcome: 'indeterminate', reason: 'host could not enumerate spawn tokens' }
          : { outcome: 'reservation-unused' }
      }
    })

    await host.restoreReadableSessions()

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
        process: { hostId: 'local', pid: 4242, processStartTimeMs: 1, spawnToken: 'spawn-new' },
        link: {
          linkId: `link-${fence}`,
          handle: { provider: 'codex' as const, threadId: THREAD },
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

    await host.restoreReadableSessions()
    expect(order).toEqual([])
    expect(scan).not.toHaveBeenCalled()
    await host.hold(SESSION, 'holder-1')

    expect(order).toEqual(['acquire'])
  })

  it('releases a conflicted record whose owner cannot be verified, signalling nothing', async () => {
    await seedStore(
      wedgedRecord({
        claimStatus: 'conflicted',
        handoffStage: 'manual-recovery',
        ownerProcess: DEAD_OWNER
      })
    )
    const stopOwnerProcess = vi.fn()
    openHost({
      probeOwner: async () => ({ outcome: 'indeterminate', reason: 'no answer' }),
      stopOwnerProcess
    })
    await host.restoreReadableSessions()

    expect(await host.attach(CALLER, hostTestAttachParams(14))).toMatchObject({ ok: true })
    expect(acquire).toHaveBeenCalledOnce()
    expect(stopOwnerProcess).not.toHaveBeenCalled()
  })
})
