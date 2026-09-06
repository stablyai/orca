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
      setOption: vi.fn()
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

describe('already-wedged profiles become usable on load', () => {
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
