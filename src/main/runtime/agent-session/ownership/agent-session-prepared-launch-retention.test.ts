import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  agentSessionOperationKey,
  pendingAgentSessionOperationRow
} from '../../../../shared/agent-session-operation-ledger'
import {
  editPersistedTestAgentSessionStore,
  openTestAgentSessionRecordStore
} from '../../agent-session-record-store-test-harness'
import { closeTestJournalHostDatabase } from '../../../native-chat/agent-session-journal/journal-host-database-test-support'
import {
  agentSessionRecordFixture,
  agentSessionLeaseFixture
} from '../../../../shared/agent-session-record.test-fixture'
import { commitAgentSessionReservation } from './agent-session-reservation-admission'
import type { AgentSessionStoreState } from '../../agent-session-store-state'

const NOW = 1_800_000_000_000
const operationId = `${NOW}-${'a'.repeat(32)}`
const callerKey = 'original-client'
const fingerprint = 'prepared-launch'
const directories: string[] = []

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    closeTestJournalHostDatabase(directory)
    await rm(directory, { recursive: true, force: true })
  }
})

describe('prepared launch obligation retention', () => {
  it('does not renew an expired retained operation through the released-reservation continuation path', () => {
    const record = agentSessionRecordFixture(
      agentSessionLeaseFixture({
        claimStatus: 'released',
        handoffStage: null,
        ownerProcess: null,
        reservedSpawnToken: null,
        provenHandleLinkId: null
      })
    )
    const row = {
      ...pendingAgentSessionOperationRow({ callerKey, operationId, fingerprint, now: NOW }),
      preparedLaunch: { daemonGeneration: 'retained-owner' }
    }
    const state: AgentSessionStoreState = {
      records: new Map([[record.sessionId, record]]),
      operations: new Map([[agentSessionOperationKey(callerKey, operationId), row]]),
      retiredClaimKeys: [],
      unreadableRecords: new Map(),
      sessionTabs: null
    }
    let supplied = false
    const result = commitAgentSessionReservation(
      state,
      {
        sessionId: record.sessionId,
        location: record.location,
        provider: record.provider,
        accountHome: record.accountHome,
        expectedFence: record.lease.runtimeFence,
        spawnToken: () => {
          supplied = true
          return 'must-not-execute'
        },
        claimKeyId: 'key',
        handoffOperationId: operationId,
        probe: { outcome: 'reservation-unused' },
        operation: { callerKey, operationId, fingerprint },
        now: row.expiresAt + 1
      },
      30_000
    )
    expect(result.disposition).toBe('replayed')
    expect(result.record).toEqual(record)
    expect(result.operationRow).toEqual(row)
    expect(supplied).toBe(false)
  })
  it.each(['pending', 'unknown', 'succeeded'] as const)(
    'retains an expired %s obligation through unrelated admission, global replay and restart without admitting execution',
    async (status) => {
      const directory = await mkdtemp(join(tmpdir(), 'orca-prepared-launch-retention-'))
      directories.push(directory)
      await openTestAgentSessionRecordStore(directory)
      const row = {
        ...pendingAgentSessionOperationRow({ callerKey, operationId, fingerprint, now: NOW }),
        outcome: status === 'succeeded' ? { status, sessionId: '' } : { status },
        // Unknown future extensions must retain identity too, without granting execution authority.
        preparedLaunch: { daemonGeneration: 'unreachable-owner', futureExtension: true }
      }
      const expiredNow = row.expiresAt + 1
      await editPersistedTestAgentSessionStore(directory, (persisted) => {
        persisted.operations[agentSessionOperationKey(callerKey, operationId)] = row
      })
      const store = await openTestAgentSessionRecordStore(directory)
      const unrelated = {
        callerKey: 'another-client',
        operationId: `${expiredNow}-${'b'.repeat(32)}`,
        fingerprint: 'unrelated',
        now: expiredNow
      }
      expect(await store.admitOperation(unrelated)).toMatchObject({ decision: 'admit' })
      expect(
        await store.admitGlobalOperation({ ...unrelated, operationId, fingerprint })
      ).toMatchObject({ decision: 'replay', row })
      expect(
        await store.admitGlobalOperation({ ...unrelated, operationId, fingerprint: 'changed' })
      ).toMatchObject({ decision: 'refused', code: 'agent_session_operation_conflict' })
      expect(await store.claimOperation({ callerKey, operationId, now: expiredNow })).toMatchObject(
        { claim: 'lost', row }
      )
      expect(
        await store.admitAndClaimOperation(
          { callerKey, operationId, fingerprint, now: expiredNow },
          () => true
        )
      ).toMatchObject({ decision: { decision: 'replay' }, claim: { claim: 'lost' } })
      await store.reconcileOnRestart({
        probe: async () => ({ outcome: 'reservation-unused' }),
        now: expiredNow
      })
      closeTestJournalHostDatabase(directory)
      const reopened = await openTestAgentSessionRecordStore(directory)
      expect(
        reopened.listOperationRows().find((saved) => saved.operationId === operationId)
      ).toEqual(row)
      expect(
        await reopened.admitOperation({ ...unrelated, operationId: `${NOW}-${'c'.repeat(32)}` })
      ).toMatchObject({ decision: 'refused', code: 'agent_session_operation_expired' })
    }
  )
})
