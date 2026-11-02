import { describe, expect, it } from 'vitest'
import {
  acquiredAgentSessionAccount,
  withAcquiredAgentSessionAccount
} from '../../shared/agent-session-acquired-account'
import { agentSessionConversationView } from '../../shared/agent-session-conversation-view'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../shared/agent-session/lifecycle/agent-session-record.test-fixture'
import { createRestTestRig } from '../native-chat/agent-session-wire/structured-agent-session-rest-test-rig'
import {
  openTestAgentSessionRecordStore,
  seedTestAgentSessionRecordStore
} from './agent-session/records/agent-session-record-store-test-harness'
import {
  proveAgentSessionOwner,
  withLease
} from './agent-session/ownership/agent-session-lease-transitions'

const RECEIVING_A = '/qa/claude-profiles/qa-a/home'

async function releasedFixture() {
  const rig = await createRestTestRig()
  const record = withAcquiredAgentSessionAccount(
    agentSessionRecordFixture(
      agentSessionLeaseFixture({
        sessionId: '6e1b4ae5-2354-4ca5-999e-647deeb23894',
        runtimeFence: 2
      })
    ),
    {
      generation: 'generation-2',
      recipe: { route: 'system', home: RECEIVING_A, configDir: RECEIVING_A }
    }
  )
  const root = record.sessionId
  await seedTestAgentSessionRecordStore(rig.root, { records: [record] })
  const store = await openTestAgentSessionRecordStore(rig.root)
  await store.reconcileOnRestart({
    sessionId: root,
    probe: async () => ({ outcome: 'exit-observed' }),
    now: 40_000
  })
  const released = store.getRecord(root)
  if (!released) {
    throw new Error('record missing after reconciliation')
  }
  return { rig, store, root, released, dispose: () => rig.dispose() }
}

describe('actual acquired account receipt in the fenced record owner', () => {
  it('reloads the last success across a proven release and reservation, then co-writes the next success', async () => {
    const f = await releasedFixture()
    try {
      expect(acquiredAgentSessionAccount(f.released, 'local')?.recipe.home).toBe(RECEIVING_A)
      expect(acquiredAgentSessionAccount(f.released, 'another-host')).toBeNull()
      expect(acquiredAgentSessionAccount({ ...f.released, sessionId: 'another-chat' })).toBeNull()
      const reserved = await f.store.reserveOwner({
        sessionId: f.root,
        location: f.released.location,
        provider: 'claude',
        accountHome: f.released.accountHome,
        expectedFence: f.released.lease.runtimeFence,
        spawnToken: 'new-spawn',
        claimKeyId: 'key-1',
        handoffOperationId: null,
        probe: { outcome: 'exit-observed' },
        now: 40_001,
        operation: {
          callerKey: 'client',
          operationId: '0000000040001-00000000000000000000000000000001',
          fingerprint: 'next-success'
        }
      })
      const current = f.store.getRecord(f.root)
      expect(reserved).toBeDefined()
      if (!current) {
        throw new Error('reservation missing')
      }
      expect(acquiredAgentSessionAccount(current)?.recipe.home).toBe(RECEIVING_A)
      await f.store.commitProcessIdentity({
        sessionId: f.root,
        fence: current.lease.runtimeFence,
        process: {
          hostId: 'local',
          pid: 4242,
          processStartTimeMs: 40_001,
          spawnToken: 'new-spawn'
        },
        now: 40_002
      })
      const recipe = {
        route: 'system' as const,
        home: '/custom/receiving',
        configDir: '/custom/receiving'
      }
      await f.store.proveOwner({
        sessionId: f.root,
        fence: current.lease.runtimeFence,
        now: 40_003,
        accountAcquisition: { generation: 'new-generation', recipe }
      })
      const reloaded = (await openTestAgentSessionRecordStore(f.rig.root)).getRecord(f.root)
      if (!reloaded) {
        throw new Error('durable proof missing')
      }
      expect(acquiredAgentSessionAccount(reloaded)?.recipe).toEqual(recipe)
      expect(acquiredAgentSessionAccount(reloaded)?.fence).toBe(current.lease.runtimeFence)
      expect(agentSessionConversationView(reloaded)).not.toHaveProperty('acquiredAccount')
    } finally {
      await f.dispose()
    }
  })

  it('does not confuse known failed reservation cleanup with an unrecorded successful older acquisition', async () => {
    const f = await releasedFixture()
    try {
      const reserved = withLease(f.released, {
        ...f.released.lease,
        runtimeFence: f.released.lease.runtimeFence + 1,
        claimStatus: 'reserved',
        handoffStage: 'new-owner-proving',
        ownerProcess: null,
        reservedSpawnToken: 'next',
        unreconciled: false
      })
      const failed = withLease(reserved, {
        ...reserved.lease,
        runtimeFence: reserved.lease.runtimeFence + 1,
        claimStatus: 'released',
        handoffStage: null,
        reservedSpawnToken: null,
        deathEvidence: {
          kind: 'exit-observed',
          detail: 'observed process exit',
          observedAt: 50_000,
          ownerFence: reserved.lease.runtimeFence
        }
      })
      expect(acquiredAgentSessionAccount(failed)?.recipe.home).toBe(RECEIVING_A)
      const process = { hostId: 'local', pid: 4242, processStartTimeMs: 50_000, spawnToken: 'next' }
      const proving = withLease(reserved, { ...reserved.lease, ownerProcess: process })
      // Older proof preserves unknown extension bytes but does not observe the successful new construction.
      const olderProof = proveAgentSessionOwner({
        record: proving,
        fence: proving.lease.runtimeFence,
        now: 50_001,
        leaseTtlMs: 30_000
      })
      expect(acquiredAgentSessionAccount(olderProof)).toBeNull()
      const olderRelease = {
        ...olderProof,
        lease: {
          ...olderProof.lease,
          runtimeFence: olderProof.lease.runtimeFence + 1,
          claimStatus: 'released' as const,
          ownerProcess: null
        }
      }
      expect(acquiredAgentSessionAccount(olderRelease)).toBeNull()
      expect(withAcquiredAgentSessionAccount(olderProof, undefined)).not.toHaveProperty(
        'acquiredAccount'
      )
      expect(
        acquiredAgentSessionAccount({ ...f.released, acquiredAccount: { version: 900 } })
      ).toBeNull()
    } finally {
      await f.dispose()
    }
  })
})
