import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { claudeProviderHandle } from '../../shared/agent-session-provider-handle-encoding'
import { agentSessionRecordFixture } from '../../shared/agent-session-record.test-fixture'
import {
  closeTestJournalHostDatabases,
  openTestJournalHostDatabase
} from '../native-chat/agent-session-journal/journal-host-database-test-support'
import { openTestAgentSessionRecordStore } from './agent-session-record-store-test-harness'
import type { AgentSessionAcquisitionExitProof } from './agent-session-acquisition-failure-settlement'

const SESSION = 'session-alpha-1'
const NOW = 1_800_000_000_000
const OPERATION_ID = `${NOW}-${'1'.repeat(32)}`
let directory: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-closed-acquisition-'))
})

afterEach(async () => {
  closeTestJournalHostDatabases()
  await rm(directory, { recursive: true, force: true })
})

async function acquisition(proved: boolean, spawned: boolean) {
  const store = await openTestAgentSessionRecordStore(directory)
  const fixture = agentSessionRecordFixture()
  const { record } = await store.reserveOwner({
    sessionId: SESSION,
    location: fixture.location,
    provider: 'claude',
    accountHome: fixture.accountHome,
    expectedFence: null,
    spawnToken: 'spawn-1',
    claimKeyId: 'key-1',
    handoffOperationId: OPERATION_ID,
    operation: { callerKey: 'caller-1', operationId: OPERATION_ID, fingerprint: 'fp-1' },
    probe: { outcome: 'reservation-unused' },
    now: NOW
  })
  const fence = record.lease.runtimeFence
  if (spawned) {
    await store.commitProcessIdentity({
      sessionId: SESSION,
      fence,
      now: NOW,
      process: { hostId: 'local', pid: 4242, processStartTimeMs: NOW, spawnToken: 'spawn-1' }
    })
  }
  if (proved) {
    await store.proveOwner({
      sessionId: SESSION,
      fence,
      now: NOW,
      link: {
        linkId: 'link-1',
        handle: claudeProviderHandle('provider-1', null),
        mintedAtFence: fence,
        observedAt: NOW,
        origin: 'created'
      }
    })
  }
  return { store, fence }
}

function failure(fence: number, exitProof: AgentSessionAcquisitionExitProof) {
  return {
    sessionId: SESSION,
    fence,
    spawnToken: 'spawn-1',
    callerKey: 'caller-1',
    operationId: OPERATION_ID,
    outcome: {
      status: 'failed' as const,
      code: 'agent_session_operation_invalid' as const,
      message: 'failed'
    },
    exitProof,
    now: NOW + 1
  }
}

describe('closed-owner proofs during failed acquisition', () => {
  it.each(['exit-proven', 'root-exit-observed', 'processless'] as const)(
    'keeps a failed reservation proof for %s',
    async (exitProof) => {
      const { store, fence } = await acquisition(false, exitProof !== 'processless')
      await store.settleFailedAcquisition(failure(fence, exitProof))
      expect(store.closedOwners(SESSION)).toEqual([
        expect.objectContaining({
          deadOwnerFence: fence,
          evidence: expect.objectContaining({ ownerFence: fence }),
          process: exitProof === 'processless' ? null : expect.objectContaining({ pid: 4242 })
        })
      ])
      expect((await openTestAgentSessionRecordStore(directory)).closedOwners(SESSION)).toEqual(
        store.closedOwners(SESSION)
      )
    }
  )

  it.each(['exit-proven', 'root-exit-observed'] as const)(
    'keeps a failed post-acquisition attachment proof for %s',
    async (exitProof) => {
      const { store, fence } = await acquisition(true, true)
      await store.settleFailedPostAcquisitionAttachment(failure(fence, exitProof))
      expect(store.closedOwners(SESSION)[0]).toMatchObject({
        deadOwnerFence: fence,
        process: { pid: 4242 },
        evidence: { kind: 'exit-observed', ownerFence: fence }
      })
    }
  )

  it.each([false, true])(
    'creates no fact for an unproven failed acquisition (proved handle: %s)',
    async (proved) => {
      const { store, fence } = await acquisition(proved, true)
      await (proved
        ? store.settleFailedPostAcquisitionAttachment(failure(fence, 'unproven'))
        : store.settleFailedAcquisition(failure(fence, 'unproven')))
      expect(store.closedOwners(SESSION)).toEqual([])
      expect(store.getRecord(SESSION)?.lease.handoffStage).toBe('recovering')
    }
  )

  it('atomically rolls back the failed acquisition, its operation answer, and its closure', async () => {
    const { store, fence } = await acquisition(false, true)
    openTestJournalHostDatabase(directory).db.exec(`CREATE TEMP TRIGGER refuse_closure
      BEFORE INSERT ON agent_session_closed_owners BEGIN SELECT RAISE(ABORT, 'closure refused'); END`)
    await expect(store.settleFailedAcquisition(failure(fence, 'exit-proven'))).rejects.toThrow(
      'closure refused'
    )
    expect(store.closedOwners(SESSION)).toEqual([])
    expect(store.getRecord(SESSION)?.lease.runtimeFence).toBe(fence)
    expect(store.getOperationRow('caller-1', OPERATION_ID)?.outcome.status).toBe('pending')
  })

  it('captures the positive unused-reservation proof at restart, with no process identity', async () => {
    await acquisition(false, false)
    const restarted = await openTestAgentSessionRecordStore(directory)
    await restarted.reconcileOnRestart({
      probe: async () => ({ outcome: 'reservation-unused' }),
      now: NOW + 1
    })
    expect(restarted.closedOwners(SESSION)[0]).toMatchObject({
      deadOwnerFence: 1,
      process: null,
      evidence: { kind: 'pid-absent', detail: 'reservation never spawned' }
    })
  })

  it('keeps a fresh unused-reservation proof when the next reservation clears it', async () => {
    const { store, fence } = await acquisition(false, false)
    await store.transitionHandoff(SESSION, (record) => ({
      ...record,
      lease: { ...record.lease, handoffOperationId: null }
    }))
    const fixture = agentSessionRecordFixture()
    await store.reserveOwner({
      sessionId: SESSION,
      location: fixture.location,
      provider: 'claude',
      accountHome: fixture.accountHome,
      expectedFence: fence,
      spawnToken: 'spawn-2',
      claimKeyId: 'key-1',
      handoffOperationId: null,
      operation: {
        callerKey: 'caller-1',
        operationId: `${NOW}-${'2'.repeat(32)}`,
        fingerprint: 'fp-2'
      },
      probe: { outcome: 'reservation-unused' },
      now: NOW + 1
    })
    expect(store.getRecord(SESSION)?.lease.deathEvidence).toBeNull()
    expect(store.closedOwners(SESSION)[0]).toMatchObject({
      deadOwnerFence: fence,
      process: null,
      evidence: { kind: 'pid-absent', detail: 'reservation never spawned' }
    })
  })

  it('creates no fact when restart drops an unverified processless reservation', async () => {
    await acquisition(false, false)
    const restarted = await openTestAgentSessionRecordStore(directory)
    await restarted.reconcileOnRestart({
      probe: async () => ({ outcome: 'indeterminate', reason: 'no answer' }),
      now: NOW + 1
    })
    expect(restarted.closedOwners(SESSION)).toEqual([])
    expect(restarted.getRecord(SESSION)?.lease.claimStatus).toBe('released')
  })

  it('rejects a stale processless probe after the owner identity arrives at the same fence', async () => {
    const { store, fence } = await acquisition(false, false)
    await store.transitionHandoff(SESSION, (record) => ({
      ...record,
      lease: { ...record.lease, handoffOperationId: null }
    }))
    await store.commitProcessIdentity({
      sessionId: SESSION,
      fence,
      now: NOW,
      process: { hostId: 'local', pid: 4242, processStartTimeMs: NOW, spawnToken: 'spawn-1' }
    })
    const fixture = agentSessionRecordFixture()
    await expect(
      store.reserveOwner({
        sessionId: SESSION,
        location: fixture.location,
        provider: 'claude',
        accountHome: fixture.accountHome,
        expectedFence: fence,
        spawnToken: 'spawn-2',
        claimKeyId: 'key-1',
        handoffOperationId: null,
        operation: {
          callerKey: 'caller-1',
          operationId: `${NOW}-${'2'.repeat(32)}`,
          fingerprint: 'fp-2'
        },
        probe: { outcome: 'pid-absent' },
        probedOwner: null,
        now: NOW + 1
      })
    ).rejects.toThrow()
    await expect(
      store.evictProvenDeadOwner({
        sessionId: SESSION,
        expectedFence: fence,
        probe: { outcome: 'pid-absent' },
        probedOwner: null,
        now: NOW + 1
      })
    ).rejects.toThrow()
    expect(store.closedOwners(SESSION)).toEqual([])
    expect(store.getRecord(SESSION)?.lease.ownerProcess?.pid).toBe(4242)
    expect(store.getRecord(SESSION)?.lease.runtimeFence).toBe(fence)
  })
})
