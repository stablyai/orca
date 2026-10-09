// Every lease write that revokes or supersedes a generation is told once, after commit, from the
// store's one transaction path, with the proof the end carried; a write that ends nothing is not.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { claudeProviderHandle } from '../../shared/agent-session-provider-handle-encoding'
import { agentSessionRecordFixture } from '../../shared/agent-session-record.test-fixture'
import { closeTestJournalHostDatabases } from '../native-chat/agent-session-journal/journal-host-database-test-support'
import { releaseStoredStructuredAgentSessionOwnerAfterExit } from '../native-chat/agent-session-wire/structured-agent-session-lease-release'
import type { AgentSessionFailedAcquisitionSettlement } from './agent-session-acquisition-failure-settlement'
import type { AgentSessionGenerationEnd } from './agent-session-generation-end'
import { releaseUnprovenAgentSessionOwner } from './agent-session-lease-transitions'
import type { AgentSessionRecordStore } from './agent-session-record-store'
import {
  openTestAgentSessionRecordStore,
  seedTestAgentSessionRecordStore
} from './agent-session-record-store-test-harness'

const SESSION = 'session-alpha-1'
const NOW = 1_800_000_000_000
let directory: string
let store: AgentSessionRecordStore
let ended: AgentSessionGenerationEnd[]
let operations = 0

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-generation-end-'))
  await seedTestAgentSessionRecordStore(directory, { records: [] })
  store = await openTestAgentSessionRecordStore(directory)
  ended = []
  store.onGenerationEnded((end) => ended.push(end))
})

afterEach(async () => {
  closeTestJournalHostDatabases()
  await rm(directory, { recursive: true, force: true })
})

function operationId(): string {
  operations += 1
  return `${NOW}-${operations.toString(16).padStart(32, '0')}`
}

/** Reserves at the next fence, as an attach does, over what the probe says of the recorded owner. */
async function reserve(
  probe: Parameters<AgentSessionRecordStore['reserveOwner']>[0]['probe']
): Promise<{ fence: number; operation: string }> {
  const operation = operationId()
  const record = store.getRecord(SESSION)
  const reserved = await store.reserveOwner({
    sessionId: SESSION,
    location: agentSessionRecordFixture().location,
    provider: 'claude',
    accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: '/home/dev/.claude' },
    expectedFence: record ? record.lease.runtimeFence : null,
    spawnToken: `spawn-${operation}`,
    claimKeyId: 'key-1',
    handoffOperationId: operation,
    probe,
    operation: { callerKey: 'client-1', operationId: operation, fingerprint: 'fp-1' },
    now: NOW
  })
  return { fence: reserved.record.lease.runtimeFence, operation }
}

/** A reservation whose child spawned and proved its handle: a live owner. */
async function liveOwner(): Promise<{ fence: number; operation: string }> {
  const reserved = await reserve({ outcome: 'indeterminate', reason: 'no owner yet' })
  await store.commitProcessIdentity({
    sessionId: SESSION,
    fence: reserved.fence,
    process: {
      hostId: 'local',
      pid: 4_000 + reserved.fence,
      processStartTimeMs: NOW,
      spawnToken: `spawn-${reserved.operation}`
    },
    now: NOW
  })
  await store.proveOwner({
    sessionId: SESSION,
    fence: reserved.fence,
    link: {
      linkId: `link-${reserved.fence}`,
      handle: claudeProviderHandle('provider-session-1', null),
      // The first start creates the conversation; each later one resumes it.
      origin: store.getRecord(SESSION)?.providerHandleChain.length ? 'resumed' : 'created',
      mintedAtFence: reserved.fence,
      observedAt: NOW
    },
    now: NOW
  })
  return reserved
}

function failedAcquisition(
  reserved: { fence: number; operation: string },
  exitProof: AgentSessionFailedAcquisitionSettlement['exitProof']
): AgentSessionFailedAcquisitionSettlement {
  return {
    sessionId: SESSION,
    fence: reserved.fence,
    spawnToken: `spawn-${reserved.operation}`,
    callerKey: 'client-1',
    operationId: reserved.operation,
    outcome: { status: 'failed', code: 'agent_session_operation_invalid', message: 'failed' },
    exitProof,
    now: NOW + 1_000
  }
}

describe('a generation that ends', () => {
  it('is told once for an observed exit’s release, with the exit’s proof', async () => {
    const { fence } = await liveOwner()
    ended = []

    await releaseStoredStructuredAgentSessionOwnerAfterExit({
      store,
      sessionId: SESSION,
      expectedFence: fence,
      now: NOW + 1_000,
      exitObservedAt: NOW + 900
    })

    expect(ended).toEqual([
      {
        sessionId: SESSION,
        endedFence: fence,
        evidence: expect.objectContaining({ kind: 'exit-observed', ownerFence: fence })
      }
    ])
  })

  it('is told once for each failed acquisition’s release', async () => {
    const first = await reserve({ outcome: 'indeterminate', reason: 'no owner yet' })
    ended = []
    await store.settleFailedAcquisition(failedAcquisition(first, 'processless'))
    expect(ended).toEqual([
      { sessionId: SESSION, endedFence: first.fence, evidence: expect.anything() }
    ])

    const second = await liveOwner()
    ended = []
    await store.settleFailedPostAcquisitionAttachment(
      failedAcquisition(second, 'root-exit-observed')
    )
    expect(ended).toEqual([
      {
        sessionId: SESSION,
        endedFence: second.fence,
        evidence: expect.objectContaining({ ownerFence: second.fence })
      }
    ])
  })

  it('is told once for an eviction, and once for a release nothing proved', async () => {
    const first = await liveOwner()
    await store.settleFailedPostAcquisitionAttachment(failedAcquisition(first, 'unproven'))
    // Parked in recovery: nothing has ended yet.
    expect(ended).toEqual([])
    await store.evictProvenDeadOwner({
      sessionId: SESSION,
      expectedFence: first.fence,
      probe: { outcome: 'pid-absent' },
      now: NOW + 2_000
    })
    expect(ended).toEqual([
      {
        sessionId: SESSION,
        endedFence: first.fence,
        evidence: expect.objectContaining({ kind: 'pid-absent', ownerFence: first.fence })
      }
    ])

    const second = await liveOwner()
    await store.settleFailedPostAcquisitionAttachment(failedAcquisition(second, 'unproven'))
    ended = []
    await store.transitionHandoff(SESSION, (record) =>
      releaseUnprovenAgentSessionOwner({ record, expectedFence: second.fence, now: NOW + 3_000 })
    )
    expect(ended).toEqual([{ sessionId: SESSION, endedFence: second.fence, evidence: null }])
  })

  it('is told once for a reservation granted over an owner the probe proved gone, with the probe’s proof the reservation clears', async () => {
    const { fence } = await liveOwner()
    ended = []

    const replaced = await reserve({ outcome: 'pid-absent' })

    expect(replaced.fence).toBe(fence + 1)
    expect(store.getRecord(SESSION)?.lease.deathEvidence).toBeNull()
    expect(ended).toEqual([
      {
        sessionId: SESSION,
        endedFence: fence,
        evidence: expect.objectContaining({ kind: 'pid-absent', ownerFence: fence })
      }
    ])
  })

  it('is told once for a restart adjudication that releases it', async () => {
    const { fence } = await liveOwner()
    closeTestJournalHostDatabases()
    store = await openTestAgentSessionRecordStore(directory)
    ended = []
    store.onGenerationEnded((end) => ended.push(end))

    await store.reconcileOnRestart({ probe: async () => ({ outcome: 'pid-absent' }), now: NOW })

    expect(ended).toEqual([
      {
        sessionId: SESSION,
        endedFence: fence,
        evidence: expect.objectContaining({ kind: 'pid-absent', ownerFence: fence })
      }
    ])
  })
})

describe('a write that ends nothing', () => {
  it('tells no one: a reservation over a released lease with no proof, a spawn, a proof, a renewal', async () => {
    await store.reconcileOnRestart({ probe: async () => ({ outcome: 'pid-absent' }), now: NOW })
    const first = await reserve({ outcome: 'indeterminate', reason: 'no owner yet' })
    await store.settleFailedAcquisition(failedAcquisition(first, 'processless'))
    const released = store.getRecord(SESSION)!.lease
    // Strip the release's proof, as one an earlier build wrote without any.
    await store.transitionHandoff(SESSION, (record) => ({
      ...record,
      lease: { ...record.lease, deathEvidence: null }
    }))
    expect(released.claimStatus).toBe('released')
    ended = []

    const { fence } = await liveOwner()
    await store.renewLease({
      sessionId: SESSION,
      fence,
      childProbe: { outcome: 'identity-matched', matchedOn: ['held-child'] },
      now: NOW + 5_000
    })
    await store.setSessionTabVisibility(SESSION, true)

    expect(ended).toEqual([])
  })

  // Design §9.8: that generation was told at its release; the reservation's clearing of the
  // release's proof is no second end.
  it('tells no one for a reservation over a lease an observed exit released with its proof', async () => {
    const first = await liveOwner()
    await releaseStoredStructuredAgentSessionOwnerAfterExit({
      store,
      sessionId: SESSION,
      expectedFence: first.fence,
      now: NOW + 1_000,
      exitObservedAt: NOW + 900
    })
    ended = []

    await liveOwner()

    expect(store.getRecord(SESSION)?.lease.deathEvidence).toBeNull()
    expect(ended).toEqual([])
  })
})
