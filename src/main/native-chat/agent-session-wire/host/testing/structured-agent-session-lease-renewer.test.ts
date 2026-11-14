import { closeTestJournalHostDatabases } from '../../../agent-session-journal/store-lifecycle/journal-host-database-test-support'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentSessionRecordStore } from '../../../../runtime/agent-session/records/agent-session-record-store'
import { openTestAgentSessionRecordStore } from '../../../../runtime/agent-session/records/agent-session-record-store-test-harness'
import { StructuredAgentSessionLeaseRenewer } from '../structured-agent-session-lease-renewer'
import { recordingStructuredAgentSessionLogger } from './structured-agent-session-logger.test-fixture'
import { codexProviderHandle } from '../../../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'

const NOW = 1_800_000_000_000
const roots: string[] = []

async function liveStore(): Promise<AgentSessionRecordStore> {
  const root = await mkdtemp(join(tmpdir(), 'orca-lease-renewer-'))
  roots.push(root)
  const store = await openTestAgentSessionRecordStore(root)
  const reserved = await store.reserveOwner({
    sessionId: 'session-renewal',
    location: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'workspace-1',
      workspaceKind: 'folder'
    },
    provider: 'codex',
    accountHome: { variable: 'CODEX_HOME', path: root },
    expectedFence: null,
    spawnToken: 'spawn-renewal',
    claimKeyId: 'key-1',
    handoffOperationId: null,
    probe: { outcome: 'reservation-unused' },
    operation: {
      callerKey: 'test',
      operationId: `${NOW}-00000000000000000000000000000001`,
      fingerprint: 'create'
    },
    now: NOW
  })
  await store.commitProcessIdentity({
    sessionId: 'session-renewal',
    fence: reserved.record.lease.runtimeFence,
    process: {
      hostId: 'local',
      pid: 4242,
      processStartTimeMs: NOW - 1_000,
      spawnToken: 'spawn-renewal'
    },
    now: NOW
  })
  await store.proveOwner({
    sessionId: 'session-renewal',
    fence: reserved.record.lease.runtimeFence,
    link: {
      linkId: 'link-renewal',
      handle: codexProviderHandle('thread-renewal'),
      origin: 'created',
      mintedAtFence: reserved.record.lease.runtimeFence,
      observedAt: NOW
    },
    now: NOW
  })
  return store
}

afterEach(async () => {
  await closeTestJournalHostDatabases()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('structured agent-session lease renewal', () => {
  it('stops only once a renewal already in flight has finished writing', async () => {
    const store = await liveStore()
    let releaseProbe = (): void => {}
    const probing = new Promise<void>((resolve) => {
      releaseProbe = resolve
    })
    const renewer = new StructuredAgentSessionLeaseRenewer({
      holdsLiveChild: () => false,
      logger: recordingStructuredAgentSessionLogger().logger,
      store,
      probe: async () => {
        await probing
        return { outcome: 'identity-matched', matchedOn: ['process-start-time'] }
      },
      now: () => NOW + 10_000
    })

    void renewer.renewNow()
    expect(store.getRecord('session-renewal')?.lease.lastRenewedAt).toBe(NOW)
    const stopped = renewer.stop()
    releaseProbe()
    await stopped

    expect(store.getRecord('session-renewal')?.lease.lastRenewedAt).toBe(NOW + 10_000)
  })
})
