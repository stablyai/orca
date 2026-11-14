import { closeTestJournalHostDatabases } from '../../../agent-session-journal/store-lifecycle/journal-host-database-test-support'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionOwnerProbe } from '../../../../../shared/agent-session/lifecycle/agent-session-lease-adjudication'
import type { AgentSessionRecordStore } from '../../../../runtime/agent-session/records/agent-session-record-store'
import { openTestAgentSessionRecordStore } from '../../../../runtime/agent-session/records/agent-session-record-store-test-harness'
import {
  resolveStructuredSessionRecovery,
  type StructuredSessionRecoveryResolutionDeps
} from '../structured-agent-session-recovery-resolution'
import { codexProviderHandle } from '../../../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'

const NOW = 1_800_000_000_000
const SESSION = 'session-recovery'
const roots: string[] = []
let operations = 0

afterEach(async () => {
  await closeTestJournalHostDatabases()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function newStoreDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-recovery-resolution-'))
  roots.push(root)
  return root
}

async function openStore(directory?: string): Promise<AgentSessionRecordStore> {
  return openTestAgentSessionRecordStore(directory ?? (await newStoreDirectory()))
}

async function reserve(store: AgentSessionRecordStore) {
  operations += 1
  return store.reserveOwner({
    sessionId: SESSION,
    location: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'workspace-1',
      workspaceKind: 'folder'
    },
    provider: 'codex',
    accountHome: { variable: 'CODEX_HOME', path: '/tmp/codex' },
    expectedFence: null,
    spawnToken: 'spawn-recovery',
    claimKeyId: 'key-1',
    handoffOperationId: null,
    probe: { outcome: 'reservation-unused' },
    operation: {
      callerKey: 'test',
      operationId: `${NOW}-${String(operations).padStart(32, '0')}`,
      fingerprint: 'create'
    },
    now: NOW
  })
}

async function liveOwner(store: AgentSessionRecordStore, pid = 4242) {
  const reserved = await reserve(store)
  const fence = reserved.record.lease.runtimeFence
  await store.commitProcessIdentity({
    sessionId: SESSION,
    fence,
    process: {
      hostId: 'local',
      pid,
      processStartTimeMs: NOW - 1_000,
      spawnToken: 'spawn-recovery'
    },
    now: NOW
  })
  return store.proveOwner({
    sessionId: SESSION,
    fence,
    link: {
      linkId: 'link-recovery',
      handle: codexProviderHandle('thread-recovery'),
      origin: 'created',
      mintedAtFence: fence,
      observedAt: NOW
    },
    now: NOW
  })
}

async function latch(store: AgentSessionRecordStore) {
  return store.transitionHandoff(SESSION, (record) => ({
    ...record,
    lease: { ...record.lease, handoffStage: 'recovering' }
  }))
}

function deps(
  store: AgentSessionRecordStore,
  probe: (calls: number) => AgentSessionOwnerProbe,
  overrides: Partial<StructuredSessionRecoveryResolutionDeps> = {}
): StructuredSessionRecoveryResolutionDeps & { probes: () => number } {
  let calls = 0
  return {
    store,
    probeRecord: async () => {
      calls += 1
      return probe(calls)
    },
    now: () => NOW + 10_000,
    delay: async () => {},
    probes: () => calls,
    ...overrides
  }
}

describe('structured session recovery resolution', () => {
  it('releases an owner whose identity cannot be verified, and signals nothing', async () => {
    const store = await openStore()
    await liveOwner(store)
    await latch(store)
    const stopOwnerProcess = vi.fn()

    const result = await resolveStructuredSessionRecovery(
      deps(store, () => ({ outcome: 'indeterminate', reason: 'probe timed out' }), {
        stopOwnerProcess
      }),
      SESSION
    )

    expect(result).toBe('resolved')
    // Saved PIDs may belong to unrelated processes.
    expect(stopOwnerProcess).not.toHaveBeenCalled()
    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      claimStatus: 'released',
      handoffStage: null,
      runtimeFence: 2,
      ownerProcess: null,
      deathEvidence: null
    })
  })

  it('releases a Windows owner the probe matches without signalling its saved pid', async () => {
    const store = await openStore()
    await liveOwner(store)
    await latch(store)
    const stopOwnerProcess = vi.fn()

    const result = await resolveStructuredSessionRecovery(
      deps(store, () => ({ outcome: 'identity-matched', matchedOn: ['process-start-time'] }), {
        stopOwnerProcess,
        platform: 'win32'
      }),
      SESSION
    )

    expect(result).toBe('resolved')
    // Windows requires a held child to stop a tree; never signal a saved PID.
    expect(stopOwnerProcess).not.toHaveBeenCalled()
    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      claimStatus: 'released',
      handoffStage: null,
      ownerProcess: null,
      deathEvidence: null
    })
  })
})
