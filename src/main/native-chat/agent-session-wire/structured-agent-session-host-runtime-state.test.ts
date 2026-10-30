import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import {
  AGENT_SESSION_RECORD_SCHEMA_VERSION,
  type AgentSessionRecord
} from '../../../shared/agent-session-record'
import { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import {
  closeTestJournalHostDatabases,
  openTestJournalHostDatabase
} from '../agent-session-journal/journal-host-database-test-support'
import { StructuredAgentSessionHostRuntimeState } from './structured-agent-session-host-runtime-state'
import type { StructuredAgentSessionHostDeps } from './structured-agent-session-host'
import { recordingStructuredAgentSessionLogger } from './structured-agent-session-logger-test-support'
import { createStructuredAgentSessionLogger } from './structured-agent-session-logger'

const NOW = 1_800_000_000_000

const stateDirectory = mkdtempSync(join(tmpdir(), 'orca-host-runtime-state-'))
afterAll(() => {
  closeTestJournalHostDatabases()
  rmSync(stateDirectory, { recursive: true, force: true })
})

function reservedRecord(): AgentSessionRecord {
  return {
    schemaVersion: AGENT_SESSION_RECORD_SCHEMA_VERSION,
    sessionId: 'session-probe',
    location: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'workspace-1',
      workspaceKind: 'folder'
    },
    provider: 'codex',
    providerHandleChain: [],
    accountHome: { variable: 'CODEX_HOME', path: '/tmp/codex' },
    lease: {
      sessionId: 'session-probe',
      runtimeKind: 'native',
      runtimeFence: 3,
      handoffStage: 'new-owner-proving',
      provenHandleLinkId: null,
      ownerProcess: null,
      reservedSpawnToken: 'spawn-probe',
      leaseDeadlineAt: NOW + 30_000,
      lastRenewedAt: NOW,
      handoffOperationId: 'op-1',
      claimKeyId: 'key-1',
      claimStatus: 'reserved',
      unreconciled: false,
      deathEvidence: null
    },
    createdAt: NOW,
    updatedAt: NOW
  }
}

function runtimeState(
  record: AgentSessionRecord | null,
  probeOwner: NonNullable<StructuredAgentSessionHostDeps['probeOwner']>,
  options: {
    store?: Partial<AgentSessionRecordStore>
    probeOwners?: StructuredAgentSessionHostDeps['probeOwners']
    now?: StructuredAgentSessionHostDeps['now']
  } = {}
) {
  const journalDatabase = openTestJournalHostDatabase(stateDirectory)
  const store = Object.assign(
    AgentSessionRecordStore.open({ journalDatabase, hostId: 'local', legacySessionTabIds: [] }),
    { getRecord: () => record, ...options.store }
  )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these runtime-state cases supply every store/probe/clock dependency they invoke; other host dependencies are unused.
  const deps = {
    store,
    adapter: {},
    journalDatabase,
    claimKeyId: 'key-1',
    probeOwner,
    probeOwners: options.probeOwners,
    now: options.now,
    logger: createStructuredAgentSessionLogger()
  } as StructuredAgentSessionHostDeps
  return new StructuredAgentSessionHostRuntimeState(deps, new Map())
}

function liveRecord(): AgentSessionRecord {
  const record = reservedRecord()
  record.lease.claimStatus = 'live'
  record.lease.ownerProcess = {
    hostId: 'local',
    pid: 4242,
    processStartTimeMs: NOW - 1_000,
    spawnToken: 'spawn-probe'
  }
  record.lease.handoffStage = null
  return record
}

describe('host runtime-state owner probe', () => {
  it('routes an ownerless reservation through the strict probe instead of fabricating proof', async () => {
    // Fabricated processless proof would permit a second writer on the same provider session.
    const probeOwner = vi.fn(async () => ({
      outcome: 'indeterminate' as const,
      reason: 'reservation named no process'
    }))
    const state = runtimeState(reservedRecord(), probeOwner)

    await expect(state.probeOwner('session-probe')).resolves.toEqual({
      outcome: 'indeterminate',
      reason: 'reservation named no process'
    })
    expect(probeOwner).toHaveBeenCalledTimes(1)
  })

  it('skips the probe for a released ownerless record acquisition never consults it for', async () => {
    const released = reservedRecord()
    released.lease.claimStatus = 'released'
    released.lease.handoffStage = null
    released.lease.reservedSpawnToken = null
    const probeOwner = vi.fn(async () => ({ outcome: 'indeterminate' as const, reason: 'x' }))
    const state = runtimeState(released, probeOwner)

    await expect(state.probeOwner('session-probe')).resolves.toEqual({
      outcome: 'reservation-unused'
    })
    expect(probeOwner).not.toHaveBeenCalled()
  })

  it('treats a session with no record at all as an unused reservation', async () => {
    const probeOwner = vi.fn(async () => ({ outcome: 'indeterminate' as const, reason: 'x' }))
    const state = runtimeState(null, probeOwner)

    await expect(state.probeOwner('session-probe')).resolves.toEqual({
      outcome: 'reservation-unused'
    })
    expect(probeOwner).not.toHaveBeenCalled()
  })

  it('constructs inert per-state reconcilers sharing only their own addressed in-flight work', async () => {
    const record = liveRecord()
    record.lease.unreconciled = true
    const pending = Promise.withResolvers<void>()
    const getRecord = vi.fn((_sessionId: string) => record)
    const reconcileOnRestart = vi.fn(
      async (args: Parameters<AgentSessionRecordStore['reconcileOnRestart']>[0]) => {
        await pending.promise
        await args.probe(record)
        await args.probeMany?.([record])
        record.lease.unreconciled = false
        return new Map()
      }
    )
    const probeOwner = vi.fn(async () => ({ outcome: 'pid-absent' as const }))
    const otherProbeOwner = vi.fn(async () => ({ outcome: 'pid-absent' as const }))
    const probeOwners = vi.fn(async () => new Map())
    const otherProbeOwners = vi.fn(async () => new Map())
    const now = vi.fn(() => NOW)
    const otherNow = vi.fn(() => NOW + 1)
    const store = { getRecord, reconcileOnRestart }
    const state = runtimeState(record, probeOwner, { store, probeOwners, now })
    const other = runtimeState(record, otherProbeOwner, {
      store,
      probeOwners: otherProbeOwners,
      now: otherNow
    })
    for (const dependency of [
      getRecord,
      reconcileOnRestart,
      probeOwner,
      otherProbeOwner,
      probeOwners,
      otherProbeOwners,
      now,
      otherNow
    ]) {
      expect(dependency).not.toHaveBeenCalled()
    }

    const first = state.reconcileLeases(record.sessionId)
    const repeated = state.reconcileLeases(record.sessionId)
    expect(reconcileOnRestart).toHaveBeenCalledTimes(1)
    const separate = other.reconcileLeases(record.sessionId)
    expect(reconcileOnRestart).toHaveBeenCalledTimes(2)
    expect(
      reconcileOnRestart.mock.calls.map(([args]) => ({ sessionId: args.sessionId, now: args.now }))
    ).toEqual([
      { sessionId: record.sessionId, now: NOW },
      { sessionId: record.sessionId, now: NOW + 1 }
    ])
    pending.resolve()
    expect(await Promise.all([first, repeated, separate])).toEqual([null, null, null])
    for (const probe of [probeOwner, otherProbeOwner]) {
      expect(probe).toHaveBeenCalledExactlyOnceWith(record)
    }
    for (const probe of [probeOwners, otherProbeOwners]) {
      expect(probe).toHaveBeenCalledExactlyOnceWith([record])
    }
    expect(now).toHaveBeenCalledOnce()
    expect(otherNow).toHaveBeenCalledOnce()
    expect(getRecord.mock.calls.every((args) => args[0] === record.sessionId)).toBe(true)
  })

  it('does not force-close a provider for transient lease probe errors', async () => {
    const onEventSinkFailure = vi.fn()
    const log = recordingStructuredAgentSessionLogger()
    const probeOwner = vi.fn(async () => {
      throw new Error('lease probe unavailable')
    })
    const record = liveRecord()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the lease renewal under test reads only listRecords and getRecord from the store.
    const deps = {
      store: {
        listRecords: () => [record],
        getRecord: () => record
      },
      adapter: {},
      journalDatabase: openTestJournalHostDatabase(stateDirectory),
      claimKeyId: 'key-1',
      probeOwner,
      logger: log.logger
    } as unknown as StructuredAgentSessionHostDeps
    const state = new StructuredAgentSessionHostRuntimeState(deps, new Map(), onEventSinkFailure)

    await (
      state as unknown as { leaseRenewer: { renewNow: () => Promise<void> } }
    ).leaseRenewer.renewNow()

    expect(log.entries).toContainEqual(
      expect.objectContaining({
        fields: expect.objectContaining({
          scope: 'lease-renewal',
          sessionId: record.sessionId,
          error: expect.any(Error)
        })
      })
    )
    expect(onEventSinkFailure).not.toHaveBeenCalled()
  })
})
