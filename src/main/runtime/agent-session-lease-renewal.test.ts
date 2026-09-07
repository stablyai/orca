import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import { AgentSessionRecordStore } from './agent-session-record-store'
import { agentSessionStorePath } from './agent-session-record-store-file'

const NOW = 1_800_000_000_000
const MATCHED = { outcome: 'identity-matched', matchedOn: ['spawn-token'] } as const
const directories: string[] = []

async function establishOwner(
  store: AgentSessionRecordStore,
  directory: string,
  suffix: string
): Promise<AgentSessionRecord> {
  const sessionId = `session-${suffix}`
  const spawnToken = `spawn-${suffix}`
  const reserved = await store.reserveOwner({
    sessionId,
    location: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'workspace-1',
      workspaceKind: 'folder'
    },
    provider: 'codex',
    accountHome: { variable: 'CODEX_HOME', path: directory },
    runtimeKind: 'native',
    expectedFence: null,
    spawnToken,
    claimKeyId: 'key-1',
    handoffOperationId: null,
    probe: { outcome: 'reservation-unused' },
    operation: {
      callerKey: 'renewal-test',
      operationId: `${NOW}-${suffix.padStart(32, '0')}`,
      fingerprint: `create-${suffix}`
    },
    now: NOW
  })
  const fence = reserved.record.lease.runtimeFence
  await store.commitProcessIdentity({
    sessionId,
    fence,
    process: { hostId: 'local', pid: 4242, processStartTimeMs: NOW - 1_000, spawnToken },
    now: NOW
  })
  return store.proveOwner({
    sessionId,
    fence,
    link: {
      linkId: `link-${suffix}`,
      handle: { provider: 'codex', threadId: `thread-${suffix}` },
      origin: 'created',
      mintedAtFence: fence,
      observedAt: NOW
    },
    now: NOW
  })
}

async function liveStore(): Promise<{ directory: string; store: AgentSessionRecordStore }> {
  const directory = await mkdtemp(join(tmpdir(), 'orca-lease-renewal-batch-'))
  directories.push(directory)
  const store = await AgentSessionRecordStore.open({ directory, hostId: 'local' })
  await establishOwner(store, directory, 'a')
  await establishOwner(store, directory, 'b')
  return { directory, store }
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('agent-session lease renewal batch', () => {
  it('refuses a stale fence without changing the record', async () => {
    const { store } = await liveStore()

    await expect(
      store.renewLeases([
        { sessionId: 'session-a', fence: 0, childProbe: MATCHED, now: NOW + 10_000 }
      ])
    ).rejects.toThrow('agent_session_checkpoint_stale')
    expect(store.getRecord('session-a')?.lease.lastRenewedAt).toBe(NOW)
  })

  it('leaves every session durable when a later renewal was superseded', async () => {
    const { directory, store } = await liveStore()
    await store.evictProvenDeadOwner({
      sessionId: 'session-b',
      expectedFence: 1,
      probe: { outcome: 'pid-absent' },
      now: NOW + 5_000
    })
    const beforeDisk = await readFile(agentSessionStorePath(directory), 'utf-8')
    const beforeFirst = store.getRecord('session-a')

    await expect(
      store.renewLeases([
        { sessionId: 'session-a', fence: 1, childProbe: MATCHED, now: NOW + 10_000 },
        { sessionId: 'session-b', fence: 1, childProbe: MATCHED, now: NOW + 10_000 }
      ])
    ).rejects.toThrow('agent_session_checkpoint_stale')

    expect(store.getRecord('session-a')).toEqual(beforeFirst)
    expect(await readFile(agentSessionStorePath(directory), 'utf-8')).toBe(beforeDisk)
    const reopened = await AgentSessionRecordStore.open({ directory, hostId: 'local' })
    expect(
      reopened
        .listRecords()
        .map((record) => record.sessionId)
        .sort()
    ).toEqual(['session-a', 'session-b'])
    expect(reopened.listRecords().every((record) => record.providerHandleChain.length > 0)).toBe(
      true
    )
  })
})
