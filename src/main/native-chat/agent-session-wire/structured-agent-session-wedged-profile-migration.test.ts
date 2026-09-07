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
import type {
  AgentSessionClaimStatus,
  AgentSessionHandoffStage,
  AgentSessionOwnerRuntimeKind,
  AgentSessionProcessIdentity,
  AgentSessionRecord
} from '../../../shared/agent-session-record'
import { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { AGENT_SESSION_STORE_FILE_NAME } from '../../runtime/agent-session-record-store-file'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import { openAgentSessionJournal } from '../agent-session-journal/journal-store-factory'
import { journalDirectoryFor } from '../agent-session-journal/journal-paths'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
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
  handoffStage: AgentSessionHandoffStage | null
  runtimeKind?: AgentSessionOwnerRuntimeKind
  ownerProcess?: AgentSessionProcessIdentity | null
  reservedSpawnToken?: string | null
  handoffOperationId?: string | null
}

/** A record in the wedged shape, with real history behind it. */
function wedgedRecord(overrides: WedgeOverrides): AgentSessionRecord {
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

async function seedStore(record: AgentSessionRecord): Promise<void> {
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
    {
      kind: 'status',
      text: 'Agent is working...',
      turnLifecycle: { turnId: 'turn-1', state: 'running' }
    },
    { fence: 13 }
  )
  await journal.close()
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
      const providerRecord: AgentSessionRecord =
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
        handoffStage: null,
        settlementRetryRequired: undefined,
        settlementRetryId: undefined
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

  it('settles restart eviction through attach when a hold arrives before the boot sweep', async () => {
    await seedStore(
      wedgedRecord({ claimStatus: 'live', handoffStage: null, ownerProcess: DEAD_OWNER })
    )
    await seedRunningTurn()
    openHost()

    await host.hold(SESSION, 'desktop-chat:restart')

    expect(acquire).toHaveBeenCalledOnce()
    expect(activeStructuredAgentSessionTurnId(restoredJournal().snapshot().items)).toBe(null)
    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      claimStatus: 'live',
      handoffStage: null,
      settlementRetryRequired: undefined,
      settlementRetryId: undefined
    })
  })

  it('settles an observed-exit latch through attach before the boot sweep', async () => {
    const record = wedgedRecord({ claimStatus: 'released', handoffStage: 'recovering' })
    record.lease.settlementRetryRequired = true
    record.lease.settlementRetryId = `provider-exit:${SESSION}:12:generation-1`
    record.lease.deathEvidence = {
      kind: 'exit-observed',
      detail: 'provider exited: transport closed',
      observedAt: NOW - 1_000
    }
    await seedStore(record)
    await seedRunningTurn()
    openHost()

    expect(await host.attach(CALLER, hostTestAttachParams(13))).toMatchObject({ ok: true })

    expect(acquire).toHaveBeenCalledOnce()
    expect(activeStructuredAgentSessionTurnId(restoredJournal().snapshot().items)).toBe(null)
    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      claimStatus: 'live',
      handoffStage: null,
      settlementRetryRequired: undefined,
      settlementRetryId: undefined
    })
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

  it('leaves a conflicted record alone while its owner cannot be proven gone', async () => {
    await seedStore(
      wedgedRecord({
        claimStatus: 'conflicted',
        handoffStage: 'manual-recovery',
        ownerProcess: DEAD_OWNER
      })
    )
    openHost({
      probeOwner: async () => ({ outcome: 'identity-matched', matchedOn: ['spawn-token'] })
    })

    await host.restoreReadableSessions()

    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      claimStatus: 'conflicted',
      handoffStage: 'manual-recovery',
      ownerProcess: { pid: DEAD_OWNER.pid }
    })
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

  it('exits a TUI reservation that crashed before its identity was committed', async () => {
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

  it('names the missing evidence when a latched record still cannot be freed', async () => {
    await seedStore(
      wedgedRecord({
        claimStatus: 'conflicted',
        handoffStage: 'manual-recovery',
        ownerProcess: DEAD_OWNER
      })
    )
    openHost({ probeOwner: async () => ({ outcome: 'indeterminate', reason: 'no answer' }) })
    await host.restoreReadableSessions()

    const refused = await host.attach(CALLER, hostTestAttachParams(13))

    expect(refused.ok).toBe(false)
    const message = refused.ok ? '' : refused.refusal.message
    expect(message).toContain('process 12546 on local')
    expect(message).not.toContain('The session store refused this call')
  })
})
