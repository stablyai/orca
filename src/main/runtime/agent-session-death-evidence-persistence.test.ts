import { closeTestJournalHostDatabases } from '../native-chat/agent-session-journal/journal-host-database-test-support'
import { upgradeStoredStructuredAgentSessionOwnerExitEvidence } from '../native-chat/agent-session-wire/structured-agent-session-lease-release'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionDeathEvidence } from '../../shared/agent-session-record'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../shared/agent-session-record.test-fixture'
import type { AgentSessionFailedAcquisitionSettlement } from './agent-session-acquisition-failure-settlement'
import type { AgentSessionRecordStore } from './agent-session-record-store'
import {
  openTestAgentSessionRecordStore,
  seedTestAgentSessionRecordStore
} from './agent-session-record-store-test-harness'
import { claudeProviderHandle } from '../../shared/agent-session-provider-handle-encoding'

const SESSION = 'session-alpha-1'
const LAST_RENEWED_AT = 30_000

let directory: string

async function seed(deathEvidence: AgentSessionDeathEvidence | null): Promise<void> {
  const lease =
    deathEvidence === null
      ? agentSessionLeaseFixture()
      : agentSessionLeaseFixture({
          ownerProcess: null,
          reservedSpawnToken: null,
          claimStatus: 'released',
          deathEvidence
        })
  await seedTestAgentSessionRecordStore(directory, { records: [agentSessionRecordFixture(lease)] })
}

function open(): Promise<AgentSessionRecordStore> {
  return openTestAgentSessionRecordStore(directory)
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-death-evidence-'))
})

afterEach(async () => {
  await closeTestJournalHostDatabases()
  await rm(directory, { recursive: true, force: true })
})

describe('death evidence on disk', () => {
  it('records the last renewal before the crash and reads it back after another restart', async () => {
    await seed(null)
    const crashed = await open()
    await crashed.reconcileOnRestart({
      probe: async () => ({ outcome: 'pid-absent' }),
      now: 90_000
    })
    const evidence = {
      kind: 'pid-absent',
      detail: 'recorded pid absent on host',
      observedAt: 90_000,
      ownerFence: 7,
      lastProvenAliveAt: LAST_RENEWED_AT
    }
    expect(crashed.getRecord(SESSION)?.lease.deathEvidence).toEqual(evidence)
    expect((await open()).getRecord(SESSION)?.lease.deathEvidence).toEqual(evidence)
  })

  it('loads evidence an older build wrote without a proven-alive time', async () => {
    const olderBuild = { kind: 'pid-absent' as const, detail: 'gone', observedAt: 90_000 }
    await seed(olderBuild)
    const store = await open()
    expect(store.isSessionUnreadable(SESSION)).toBe(false)
    expect(store.getRecord(SESSION)?.lease.deathEvidence).toEqual(olderBuild)
  })

  it.each([
    ['proves the owner alive after the probe found it gone', { lastProvenAliveAt: 90_001 }],
    ['names no possible owner', { ownerFence: -1 }]
  ])('quarantines evidence that %s', async (_why, field) => {
    await seed({ kind: 'pid-absent', detail: 'gone', observedAt: 90_000, ...field })
    expect((await open()).isSessionUnreadable(SESSION)).toBe(true)
  })
})

describe('who is told a proof of death landed', () => {
  it('tells a listener once the proof is committed, and never for a write that proves nothing', async () => {
    await seed(null)
    const store = await open()
    const told: unknown[] = []
    store.onDeathEvidence((sessionId) => told.push(store.getRecord(sessionId)?.lease.deathEvidence))
    const unsubscribed = vi.fn()
    store.onDeathEvidence(unsubscribed)()

    await expect(
      store.evictProvenDeadOwner({
        sessionId: SESSION,
        expectedFence: 6,
        probe: { outcome: 'pid-absent' },
        now: 80_000
      })
    ).rejects.toThrow()
    await store.reconcileOnRestart({ probe: async () => ({ outcome: 'pid-absent' }), now: 90_000 })
    // Already-persisted proof must not notify again on unrelated writes.
    await store.setSessionTabVisibility(SESSION, true)

    expect(told).toEqual([expect.objectContaining({ kind: 'pid-absent', ownerFence: 7 })])
    expect(unsubscribed).not.toHaveBeenCalled()
  })
})

describe('a failed acquisition', () => {
  const NOW = 1_800_000_000_000
  const OPERATION_ID = `${NOW}-${'1'.padStart(32, '0')}`

  async function spawnedOwner(store: AgentSessionRecordStore): Promise<number> {
    const reserved = await store.reserveOwner({
      sessionId: SESSION,
      location: agentSessionRecordFixture().location,
      provider: 'claude',
      accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: '/home/dev/.claude' },
      expectedFence: null,
      spawnToken: 'spawn-a',
      claimKeyId: 'key-1',
      handoffOperationId: OPERATION_ID,
      probe: { outcome: 'indeterminate', reason: 'no answer' },
      operation: { callerKey: 'client-1', operationId: OPERATION_ID, fingerprint: 'fp-1' },
      now: NOW
    })
    const fence = reserved.record.lease.runtimeFence
    await store.commitProcessIdentity({
      sessionId: SESSION,
      fence,
      process: { hostId: 'local', pid: 4242, processStartTimeMs: NOW, spawnToken: 'spawn-a' },
      now: NOW
    })
    return fence
  }

  function unproven(fence: number, now: number): AgentSessionFailedAcquisitionSettlement {
    return {
      sessionId: SESSION,
      fence,
      spawnToken: 'spawn-a',
      callerKey: 'client-1',
      operationId: OPERATION_ID,
      outcome: { status: 'failed', code: 'agent_session_operation_invalid', message: 'failed' },
      exitProof: 'unproven',
      now
    }
  }

  it.each([
    ['before the owner proved its handle', false],
    ['after the owner proved its handle', true]
  ] as const)(
    'parks in recovery keeping the last proof of life, not the failure, %s',
    async (_when, proved) => {
      const store = await open()
      const fence = await spawnedOwner(store)
      if (proved) {
        await store.proveOwner({
          sessionId: SESSION,
          fence,
          link: {
            linkId: 'link-1',
            handle: claudeProviderHandle('provider-session-1', null),
            origin: 'created',
            mintedAtFence: fence,
            observedAt: NOW
          },
          now: NOW
        })
        await store.settleFailedPostAcquisitionAttachment(unproven(fence, NOW + 60_000))
      } else {
        await store.settleFailedAcquisition(unproven(fence, NOW + 60_000))
      }
      expect(store.getRecord(SESSION)?.lease).toMatchObject({
        handoffStage: 'recovering',
        lastRenewedAt: NOW
      })

      const evicted = await store.evictProvenDeadOwner({
        sessionId: SESSION,
        expectedFence: fence,
        probe: { outcome: 'pid-absent' },
        now: NOW + 120_000
      })
      expect(evicted.lease.deathEvidence).toMatchObject({ lastProvenAliveAt: NOW })
    }
  )

  it.each(['exit-proven', 'root-exit-observed', 'processless'] as const)(
    'names its own fence in the proof when cleanup settles it %s',
    async (exitProof) => {
      const store = await open()
      const fence = await spawnedOwner(store)
      const settled =
        exitProof === 'processless'
          ? await store.settleFailedAcquisition({ ...unproven(fence, NOW), exitProof })
          : await (async () => {
              await store.proveOwner({
                sessionId: SESSION,
                fence,
                link: {
                  linkId: 'link-1',
                  handle: claudeProviderHandle('provider-session-1', null),
                  origin: 'created',
                  mintedAtFence: fence,
                  observedAt: NOW
                },
                now: NOW
              })
              return store.settleFailedPostAcquisitionAttachment({
                ...unproven(fence, NOW),
                exitProof
              })
            })()
      expect(settled.lease.deathEvidence).toMatchObject({ ownerFence: fence })
    }
  )
})

it.each([10, 100])(
  'bounds same-fence evidence work with %s records and duplicate events',
  async (population) => {
    const releasedWriter = { fence: 7, generation: 'released-writer-generation' }
    const evidence = {
      kind: 'kill-delivered' as const,
      detail: 'writer terminated',
      observedAt: 90000,
      ownerFence: releasedWriter.fence
    }
    const records = Array.from({ length: population }, (_, index) =>
      agentSessionRecordFixture(
        agentSessionLeaseFixture({
          sessionId: index === 0 ? SESSION : `session-other-${index}`,
          runtimeFence: releasedWriter.fence,
          ownerProcess: null,
          reservedSpawnToken: null,
          claimStatus: 'released',
          deathEvidence: evidence
        })
      )
    )
    await seedTestAgentSessionRecordStore(directory, { records })
    const store = await open()
    const unrelated = records.slice(1).map((record) => store.getRecord(record.sessionId))
    const transition = vi.spyOn(store, 'transitionHandoff')
    const notified = vi.fn()
    const unsubscribe = store.onDeathEvidence(notified)
    const event = {
      type: 'ended' as const,
      sessionId: SESSION,
      fence: releasedWriter.fence,
      acquisitionGeneration: releasedWriter.generation,
      cause: 'requested-close' as const,
      reason: 'late exit',
      observedAt: 91000
    }
    try {
      await upgradeStoredStructuredAgentSessionOwnerExitEvidence(
        store,
        { ...event, deathEvidenceKind: 'kill-delivered' },
        92000
      )
      expect(transition).not.toHaveBeenCalled()
      await upgradeStoredStructuredAgentSessionOwnerExitEvidence(store, event, 92000)
      expect(transition).toHaveBeenCalledOnce()
      expect(notified).toHaveBeenCalledExactlyOnceWith(SESSION)
      records
        .slice(1)
        .forEach((record, index) =>
          expect(store.getRecord(record.sessionId)).toBe(unrelated[index])
        )
      expect((await open()).getRecord(SESSION)?.lease.deathEvidence?.kind).toBe('exit-observed')
      transition.mockClear()
      notified.mockClear()
      for (let index = 0; index < population; index++) {
        await upgradeStoredStructuredAgentSessionOwnerExitEvidence(store, event, 92000)
      }
      expect(transition).not.toHaveBeenCalled()
      expect(notified).not.toHaveBeenCalled()
      await store.transitionHandoff(SESSION, (current) => ({
        ...current,
        lease: {
          ...current.lease,
          ...agentSessionLeaseFixture({ runtimeFence: 8, provenHandleLinkId: null })
        }
      }))
      const successor = store.getRecord(SESSION)
      transition.mockClear()
      notified.mockClear()
      for (let index = 0; index < population; index++) {
        await upgradeStoredStructuredAgentSessionOwnerExitEvidence(store, event, 93000)
      }
      expect(transition).not.toHaveBeenCalled()
      expect(notified).not.toHaveBeenCalled()
      expect(store.getRecord(SESSION)).toBe(successor)
    } finally {
      unsubscribe()
      transition.mockRestore()
    }
  }
)
