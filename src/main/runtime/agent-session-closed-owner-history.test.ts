import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionOwnerProbe } from '../../shared/agent-session-lease-adjudication'
import { AGENT_SESSION_JOURNAL_SCHEMA_VERSION } from '../../shared/agent-session-journal-types'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../shared/agent-session-record.test-fixture'
import {
  closeTestJournalHostDatabases,
  openTestJournalHostDatabase
} from '../native-chat/agent-session-journal/journal-host-database-test-support'
import {
  insertJournalRow,
  publishJournalSessionEpoch
} from '../native-chat/agent-session-journal/journal-row-table'
import { JournalRowWriter } from '../native-chat/agent-session-journal/journal-row-writer'
import type { JournalRow } from '../native-chat/agent-session-journal/journal-row-schema'
import { JOURNAL_DB_SCHEMA_VERSION } from '../native-chat/agent-session-journal/journal-database-schema'
import { loadAgentSessionStoreRows } from './agent-session-record-rows'
import { AgentSessionStoreTransactions } from './agent-session-store-transactions'
import type { AgentSessionRecordStore } from './agent-session-record-store'
import {
  openTestAgentSessionRecordStore,
  seedTestAgentSessionRecordStore
} from './agent-session-record-store-test-harness'
import { releaseStoredAgentSessionOwnerAfterSurfaceClose } from './agent-session-surface-release-transition'
import { releaseUnprovenAgentSessionOwner } from './agent-session-lease-transitions'
import { createStructuredAgentSessionOwnerProbe } from './structured-agent-session-owner-probe'
import {
  agentSessionClosedOwnerKey,
  type AgentSessionClosedOwner
} from './agent-session-closed-owner'
import { beginAgentSessionRuntimeIncarnationForTest } from './agent-session-runtime-attribution'
import { recordAgentSessionRuntimeEnd } from './agent-session-runtime-end-record'

const SESSION = 'session-alpha-1'
const NOW = 1_800_000_000_000
const MATCHED: AgentSessionOwnerProbe = { outcome: 'identity-matched', matchedOn: ['spawn-token'] }
let directory: string
let serial = 0

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-closed-owners-'))
})

afterEach(async () => {
  closeTestJournalHostDatabases()
  vi.restoreAllMocks()
  await rm(directory, { recursive: true, force: true })
})

function hostDatabase() {
  return openTestJournalHostDatabase(directory)
}

function journalRow(seq: number, epoch = 'epoch-1'): JournalRow {
  return {
    v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
    epoch,
    seq,
    fence: 7,
    ts: NOW + seq,
    kind: 'epoch',
    reason: 'session_created',
    providerHandle: { kind: 'claude', sessionId: 'provider-session-alpha-1', leafUuid: null }
  }
}

function seedJournal(): void {
  hostDatabase().transaction((db) => {
    publishJournalSessionEpoch(db, { sessionId: SESSION, workspaceId: 'workspace-1' }, 'epoch-1')
    insertJournalRow(db, SESSION, journalRow(1))
  })
}

async function loadedOwner(record = agentSessionRecordFixture()): Promise<AgentSessionRecordStore> {
  await seedTestAgentSessionRecordStore(directory, { records: [record] })
  return openTestAgentSessionRecordStore(directory)
}

async function liveOwner(): Promise<AgentSessionRecordStore> {
  const store = await loadedOwner()
  await store.reconcileOnRestart({ probe: async () => MATCHED, now: NOW })
  await store.transitionHandoff(SESSION, (record) => ({
    ...record,
    lease: { ...record.lease, handoffStage: null }
  }))
  seedJournal()
  return store
}

function reservation(record: AgentSessionRecord, probe: AgentSessionOwnerProbe) {
  serial += 1
  const operationId = `${NOW}-${String(serial).padStart(32, '0')}`
  return {
    sessionId: record.sessionId,
    location: record.location,
    provider: 'claude' as const,
    accountHome: record.accountHome,
    expectedFence: record.lease.runtimeFence,
    spawnToken: `spawn-${serial}`,
    claimKeyId: 'key-1',
    handoffOperationId: operationId,
    operation: { callerKey: 'caller-1', operationId, fingerprint: `fp-${serial}` },
    probe,
    now: NOW + 100
  }
}

function requiredRecord(store: AgentSessionRecordStore): AgentSessionRecord {
  const record = store.getRecord(SESSION)
  if (!record) {
    throw new Error('missing test owner')
  }
  return record
}

function requiredFact(store: AgentSessionRecordStore): AgentSessionClosedOwner {
  const fact = store.closedOwners(SESSION)[0]
  if (!fact) {
    throw new Error('missing test closed owner')
  }
  return fact
}

function factCount(): number {
  return Number(
    hostDatabase().db.prepare('SELECT count(*) AS n FROM agent_session_closed_owners').get()?.n
  )
}

const proofTransitions = [
  'surface exit',
  'explicit eviction',
  'restart eviction',
  'reservation probe'
] as const

async function closeOwner(
  store: AgentSessionRecordStore,
  transition: (typeof proofTransitions)[number]
) {
  if (transition === 'surface exit') {
    await releaseStoredAgentSessionOwnerAfterSurfaceClose(store, {
      sessionId: SESSION,
      expectedFence: 7,
      now: NOW + 10,
      exitObservedAt: NOW + 1,
      exitReason: 'root exited'
    })
  } else if (transition === 'explicit eviction') {
    await store.evictProvenDeadOwner({
      sessionId: SESSION,
      expectedFence: 7,
      probe: { outcome: 'identity-mismatch', field: 'process-start-time' },
      now: NOW + 10
    })
  } else if (transition === 'restart eviction') {
    await store.transitionHandoff(SESSION, (record) => ({
      ...record,
      lease: { ...record.lease, unreconciled: true }
    }))
    await store.reconcileOnRestart({
      probe: async () => ({ outcome: 'pid-absent' }),
      now: NOW + 10
    })
  } else {
    await store.reserveOwner(reservation(requiredRecord(store), { outcome: 'pid-absent' }))
  }
}

describe('committed closed-owner facts', () => {
  it.each(proofTransitions)(
    'keeps the %s proof after replacement and restart',
    async (transition) => {
      const store = await liveOwner()
      const original = requiredRecord(store)
      const committed: AgentSessionClosedOwner[] = []
      const legacy = vi.fn()
      store.onDeathEvidence(legacy)
      store.onClosedOwner((fact) => {
        expect(factCount()).toBe(1)
        committed.push(fact)
      })
      await closeOwner(store, transition)
      const fact = requiredFact(store)
      expect(fact).toMatchObject({
        schemaVersion: 1,
        sessionId: SESSION,
        deadOwnerFence: 7,
        location: original.location,
        process: { hostId: 'local', pid: 4242, processStartTimeMs: 1_700_000_000_000 },
        evidence: { ownerFence: 7 }
      })
      expect(fact.process).not.toHaveProperty('spawnToken')
      if ('path' in original.accountHome) {
        expect(JSON.stringify(fact)).not.toContain(original.accountHome.path)
      }
      expect(committed).toEqual([fact])
      if (transition === 'reservation probe') {
        expect(legacy).not.toHaveBeenCalled()
      } else {
        expect(legacy).toHaveBeenCalledWith(SESSION, fact)
        await store.reserveOwner(
          reservation(requiredRecord(store), { outcome: 'reservation-unused' })
        )
      }
      expect(requiredRecord(store).lease.deathEvidence).toBeNull()
      expect(store.closedOwners(SESSION)).toEqual([fact])
      closeTestJournalHostDatabases()
      expect((await openTestAgentSessionRecordStore(directory)).closedOwners(SESSION)).toEqual([
        fact
      ])
    }
  )

  it.each(proofTransitions)('rolls back the %s and its fact together', async (transition) => {
    const store = await liveOwner()
    const listener = vi.fn()
    store.onClosedOwner(listener)
    hostDatabase().db
      .exec(`CREATE TEMP TRIGGER refuse_closure BEFORE INSERT ON agent_session_closed_owners
      BEGIN SELECT RAISE(ABORT, 'closure refused'); END`)
    await expect(closeOwner(store, transition)).rejects.toThrow('closure refused')
    expect(requiredRecord(store).lease.runtimeFence).toBe(7)
    expect(requiredRecord(store).lease.deathEvidence).toBeNull()
    expect(store.closedOwners(SESSION)).toEqual([])
    expect(factCount()).toBe(0)
    expect(listener).not.toHaveBeenCalled()
    expect(
      hostDatabase().db.prepare('SELECT count(*) AS n FROM agent_session_operations').get()?.n
    ).toBe(0)
  })

  it('orders immutable facts by generation even if the clock moves back', async () => {
    const store = await liveOwner()
    await closeOwner(store, 'surface exit')
    const first = requiredFact(store)
    const request = reservation(requiredRecord(store), { outcome: 'reservation-unused' })
    const { record } = await store.reserveOwner(request)
    await store.commitProcessIdentity({
      sessionId: SESSION,
      fence: record.lease.runtimeFence,
      process: {
        hostId: 'local',
        pid: 4243,
        processStartTimeMs: NOW,
        spawnToken: request.spawnToken
      },
      now: NOW
    })
    await store.evictProvenDeadOwner({
      sessionId: SESSION,
      expectedFence: record.lease.runtimeFence,
      probe: { outcome: 'pid-absent' },
      now: NOW - 1
    })
    const facts = store.closedOwners(SESSION)
    expect(facts.map((fact) => fact.deadOwnerFence)).toEqual([7, 9])
    expect(facts[0]).toBe(first)
    expect(facts[1]?.evidence.lastProvenAliveAt).toBe(NOW - 1)
    expect(() => Object.assign(first.evidence, { detail: 'changed' })).toThrow(TypeError)
  })

  it.each(['restart eviction', 'reservation probe'] as const)(
    'keeps the earlier runtime end cause in the %s fact',
    async (transition) => {
      const store = await liveOwner()
      const original = requiredRecord(store)
      const owner = original.lease.ownerProcess
      if (!owner) {
        throw new Error('missing fixture process')
      }
      await store.transitionHandoff(SESSION, (record) => ({
        ...record,
        lease: { ...record.lease, ownerProcess: { ...owner, runtime: undefined } }
      }))
      recordAgentSessionRuntimeEnd('update', NOW)
      beginAgentSessionRuntimeIncarnationForTest()
      const restarted = await openTestAgentSessionRecordStore(directory)
      if (transition === 'restart eviction') {
        await restarted.reconcileOnRestart({
          probe: async () => ({ outcome: 'pid-absent' }),
          now: NOW + 1
        })
      } else {
        await restarted.reconcileOnRestart({ probe: async () => MATCHED, now: NOW + 1 })
        await restarted.transitionHandoff(SESSION, (record) => ({
          ...record,
          lease: { ...record.lease, handoffStage: null }
        }))
        await closeOwner(restarted, transition)
      }
      expect(requiredFact(restarted).evidence.runtimeEnd).toBe('update')
    }
  )
})

describe('proof requirements and stale observations', () => {
  it('records nothing for an expired lease and an indeterminate reservation probe', async () => {
    const store = await liveOwner()
    await expect(
      store.reserveOwner(
        reservation(requiredRecord(store), {
          outcome: 'indeterminate',
          reason: 'disconnected'
        })
      )
    ).rejects.toThrow()
    expect(store.closedOwners(SESSION)).toEqual([])
    expect(factCount()).toBe(0)
  })

  it('records nothing for an unproven release', async () => {
    const store = await loadedOwner()
    await store.reconcileOnRestart({
      probe: async () => ({ outcome: 'indeterminate', reason: 'disconnected' }),
      now: NOW
    })
    await store.transitionHandoff(SESSION, (record) =>
      releaseUnprovenAgentSessionOwner({
        record,
        expectedFence: 7,
        now: NOW + 1
      })
    )
    await store.reserveOwner(reservation(requiredRecord(store), { outcome: 'reservation-unused' }))
    expect(store.closedOwners(SESSION)).toEqual([])
  })

  it('records nothing when a local host cannot verify an SSH owner', async () => {
    const remote = agentSessionRecordFixture()
    const owner = remote.lease.ownerProcess
    if (!owner) {
      throw new Error('missing fixture process')
    }
    const store = await loadedOwner({
      ...remote,
      location: { ...remote.location, executionHostId: 'ssh:host' },
      lease: { ...remote.lease, ownerProcess: { ...owner, hostId: 'ssh:host' } }
    })
    await store.reconcileOnRestart({
      probe: createStructuredAgentSessionOwnerProbe('local'),
      now: NOW
    })
    expect(requiredRecord(store).lease.handoffStage).toBe('recovering')
    expect(store.closedOwners(SESSION)).toEqual([])
  })

  it('rejects a stale reservation probe and delayed exit without closing the successor', async () => {
    const store = await liveOwner()
    const stale = reservation(requiredRecord(store), { outcome: 'pid-absent' })
    await closeOwner(store, 'reservation probe')
    const fact = requiredFact(store)
    await expect(store.reserveOwner(stale)).rejects.toThrow()
    await expect(
      releaseStoredAgentSessionOwnerAfterSurfaceClose(store, {
        sessionId: SESSION,
        expectedFence: 7,
        now: NOW + 1
      })
    ).rejects.toThrow()
    expect(store.closedOwners(SESSION)).toEqual([fact])
    expect(factCount()).toBe(1)
  })

  it('ignores a delayed restart probe after the compared owner changed', async () => {
    const store = await loadedOwner()
    let answer: (probe: AgentSessionOwnerProbe) => void = () => {
      throw new Error('probe not started')
    }
    const began = Promise.withResolvers<void>()
    const reconciliation = store.reconcileOnRestart({
      probe: () => {
        began.resolve()
        return new Promise((resolve) => {
          answer = resolve
        })
      },
      now: NOW
    })
    await began.promise
    await store.reconcileOnRestart({ probe: async () => MATCHED, now: NOW + 1 })
    await store.transitionHandoff(SESSION, (record) => ({
      ...record,
      lease: { ...record.lease, unreconciled: true }
    }))
    answer({ outcome: 'pid-absent' })
    expect((await reconciliation).size).toBe(0)
    expect(store.closedOwners(SESSION)).toEqual([])
  })

  it('captures a folder workspace in its WSL execution scope without needing Git', async () => {
    const record = agentSessionRecordFixture()
    const store = await loadedOwner({
      ...record,
      location: { ...record.location, wslDistro: 'Ubuntu', workspaceKind: 'folder' }
    })
    await store.reconcileOnRestart({ probe: async () => ({ outcome: 'pid-absent' }), now: NOW })
    expect(requiredFact(store).location).toMatchObject({
      wslDistro: 'Ubuntu',
      workspaceKind: 'folder'
    })
    expect(agentSessionClosedOwnerKey(requiredFact(store))).toContain('Ubuntu')
  })
})

describe('retiring a fact', () => {
  function writer() {
    return new JournalRowWriter({
      sessionId: SESSION,
      now: () => NOW,
      serialize: async (run) => run(),
      database: hostDatabase,
      readOnly: () => false,
      highestFence: () => 7,
      nextSequence: () => 2,
      commit: () => {}
    })
  }

  it('deletes only when the journal write commits and never reconstructs a retired fact', async () => {
    const store = await liveOwner()
    await closeOwner(store, 'surface exit')
    const receipt = store.closedOwnerReceipt(requiredFact(store))
    await writer().enqueue((seq) => journalRow(seq), undefined, {
      write: (db) => {
        receipt.write(db)
        expect(store.closedOwners(SESSION)).toHaveLength(1)
      },
      committed: receipt.committed
    })
    expect(store.closedOwners(SESSION)).toEqual([])
    expect(factCount()).toBe(0)
    closeTestJournalHostDatabases()
    expect((await openTestAgentSessionRecordStore(directory)).closedOwners(SESSION)).toEqual([])
  })

  it('keeps the fact in memory and on disk when the journal write rolls back after the receipt', async () => {
    const store = await liveOwner()
    await closeOwner(store, 'surface exit')
    const fact = requiredFact(store)
    const receipt = store.closedOwnerReceipt(fact)
    await expect(
      writer().enqueue((seq) => journalRow(seq), undefined, {
        write: (db) => {
          receipt.write(db)
          throw new Error('journal transaction failed')
        },
        committed: receipt.committed
      })
    ).rejects.toThrow('journal transaction failed')
    expect(store.closedOwners(SESSION)).toEqual([fact])
    expect(factCount()).toBe(1)
    expect(hostDatabase().db.prepare('SELECT MAX(seq) AS n FROM journal_rows').get()?.n).toBe(1)
    await store.setConversationName(SESSION, 'after rollback')
    closeTestJournalHostDatabases()
    expect((await openTestAgentSessionRecordStore(directory)).closedOwners(SESSION)).toEqual([fact])
  })

  it('removes facts with a session record in the store transaction', async () => {
    const store = await liveOwner()
    await closeOwner(store, 'surface exit')
    const database = hostDatabase()
    const transactions = new AgentSessionStoreTransactions(
      database,
      loadAgentSessionStoreRows(database.db)
    )
    await transactions.transact((draft) => {
      draft.records.delete(SESSION)
    })
    expect(transactions.state.closedOwners.size).toBe(0)
    expect(factCount()).toBe(0)
    expect(
      database.db.prepare('SELECT 1 FROM agent_session_records WHERE session_id = ?').get(SESSION)
    ).toBeUndefined()
  })

  it('also cascades when the session row itself is deleted', async () => {
    const store = await liveOwner()
    await closeOwner(store, 'surface exit')
    hostDatabase().transaction((db) => {
      db.prepare('DELETE FROM agent_session_records WHERE session_id = ?').run(SESSION)
    })
    expect(factCount()).toBe(0)
  })
})

describe('host schema and legacy proof migration', () => {
  const legacyProof = agentSessionRecordFixture(
    agentSessionLeaseFixture({
      claimStatus: 'released',
      ownerProcess: null,
      reservedSpawnToken: null,
      runtimeFence: 8,
      deathEvidence: { kind: 'pid-absent', detail: 'old proof', observedAt: NOW, ownerFence: 7 }
    })
  )

  /** A database a build without the closed-owner table wrote, at `userVersion`. */
  async function databaseWithoutClosedOwners(
    record: AgentSessionRecord,
    userVersion = JOURNAL_DB_SCHEMA_VERSION
  ): Promise<void> {
    await seedTestAgentSessionRecordStore(directory, { records: [record] })
    hostDatabase().db.exec('DROP TABLE agent_session_closed_owners')
    hostDatabase().db.pragma(`user_version = ${userVersion}`)
    closeTestJournalHostDatabases()
  }

  function closedOwnersTableExists(): boolean {
    return (
      hostDatabase()
        .db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get('agent_session_closed_owners') !== undefined
    )
  }

  it('migrates an attributed old proof once without changing the schema version', async () => {
    await databaseWithoutClosedOwners(legacyProof)
    const migrated = await openTestAgentSessionRecordStore(directory)
    expect(hostDatabase().db.pragma('user_version', { simple: true })).toBe(
      JOURNAL_DB_SCHEMA_VERSION
    )
    expect(requiredFact(migrated)).toMatchObject({ deadOwnerFence: 7, process: null })
    const receipt = migrated.closedOwnerReceipt(requiredFact(migrated))
    hostDatabase().transaction(receipt.write)
    receipt.committed()
    closeTestJournalHostDatabases()
    // The old proof is still on the lease; a second migration would bring the retired fact back.
    const reopened = await openTestAgentSessionRecordStore(directory)
    expect(requiredRecord(reopened).lease.deathEvidence?.ownerFence).toBe(7)
    expect(reopened.closedOwners(SESSION)).toEqual([])
    expect(factCount()).toBe(0)
  })

  it('never migrates into a table that already exists', async () => {
    await seedTestAgentSessionRecordStore(directory, { records: [legacyProof] })
    expect(closedOwnersTableExists()).toBe(true)
    closeTestJournalHostDatabases()
    const store = await openTestAgentSessionRecordStore(directory)
    expect(store.closedOwners(SESSION)).toEqual([])
    expect(factCount()).toBe(0)
  })

  it('neither creates nor migrates on a read-only open of a newer schema', async () => {
    await databaseWithoutClosedOwners(legacyProof, JOURNAL_DB_SCHEMA_VERSION + 1)
    const olderHost = await openTestAgentSessionRecordStore(directory)
    expect(olderHost.readOnly).toBe(true)
    expect(olderHost.closedOwners(SESSION)).toEqual([])
    expect(closedOwnersTableExists()).toBe(false)
  })

  it('leaves legacy evidence without a named generation alone', async () => {
    await databaseWithoutClosedOwners(
      agentSessionRecordFixture(
        agentSessionLeaseFixture({
          claimStatus: 'released',
          ownerProcess: null,
          reservedSpawnToken: null,
          deathEvidence: { kind: 'pid-absent', detail: 'unknown owner', observedAt: NOW }
        })
      )
    )
    const store = await openTestAgentSessionRecordStore(directory)
    expect(store.closedOwners(SESSION)).toEqual([])
    expect(requiredRecord(store).lease.deathEvidence?.detail).toBe('unknown owner')
  })

  it('refuses owner mutations and delete receipts on a newer host schema', async () => {
    const store = await liveOwner()
    await closeOwner(store, 'surface exit')
    const fact = requiredFact(store)
    hostDatabase().db.pragma(`user_version = ${JOURNAL_DB_SCHEMA_VERSION + 1}`)
    closeTestJournalHostDatabases()
    const olderHost = await openTestAgentSessionRecordStore(directory)
    expect(olderHost.readOnly).toBe(true)
    expect(olderHost.closedOwners(SESSION)).toEqual([fact])
    await expect(olderHost.setConversationName(SESSION, 'no write')).rejects.toThrow()
    expect(() => olderHost.closedOwnerReceipt(fact).write(hostDatabase().db)).toThrow()
    expect(factCount()).toBe(1)
  })
})
