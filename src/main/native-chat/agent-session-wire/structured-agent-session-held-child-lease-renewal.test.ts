import { closeTestJournalHostDatabases } from '../agent-session-journal/journal-host-database-test-support'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { probeAgentSessionProcessIdentity } from '../../runtime/agent-session/ownership/agent-session-process-identity-probe'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import type { StructuredAgentSessionProviderChild } from './structured-agent-session-host-types'
import { StructuredAgentSessionLeaseRenewer } from './structured-agent-session-lease-renewer'
import { recordingStructuredAgentSessionLogger } from './structured-agent-session-logger-test-support'
import { holdsLiveProviderChild } from './structured-agent-session-provider-child'

const NOW = 1_800_000_000_000
const SESSION = 'session-held'
const roots: string[] = []

afterEach(async () => {
  await closeTestJournalHostDatabases()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function liveStoreWithoutStartTime(): Promise<{
  root: string
  store: AgentSessionRecordStore
  fence: number
}> {
  const root = await mkdtemp(join(tmpdir(), 'orca-held-child-renewal-'))
  roots.push(root)
  const store = await openTestAgentSessionRecordStore(root)
  const reserved = await store.reserveOwner({
    sessionId: SESSION,
    location: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'workspace-1',
      workspaceKind: 'folder'
    },
    provider: 'codex',
    accountHome: { variable: 'CODEX_HOME', path: root },
    expectedFence: null,
    spawnToken: 'spawn-held',
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
  const fence = reserved.record.lease.runtimeFence
  await store.commitProcessIdentity({
    sessionId: SESSION,
    fence,
    process: { hostId: 'local', pid: 4242, processStartTimeMs: null, spawnToken: 'spawn-held' },
    now: NOW
  })
  await store.proveOwner({
    sessionId: SESSION,
    fence,
    link: {
      linkId: 'link-held',
      handle: codexProviderHandle('thread-held'),
      origin: 'created',
      mintedAtFence: fence,
      observedAt: NOW
    },
    now: NOW
  })
  return { root, store, fence }
}

/** Present PID without start time/token evidence, using the real platform probe. */
function pidProbe(platform: NodeJS.Platform) {
  return vi.fn((record: AgentSessionRecord) =>
    probeAgentSessionProcessIdentity({
      identity: record.lease.ownerProcess!,
      deps: { platform, isPidPresent: () => true }
    })
  )
}

function hostWith(child: StructuredAgentSessionProviderChild | null) {
  const session = { child }
  const adapter: { liveGeneration: string | null } = { liveGeneration: 'gen-1' }
  return {
    adapter,
    holdsLiveChild: (sessionId: string, fence: number) =>
      holdsLiveProviderChild(
        sessionId === SESSION ? session : undefined,
        fence,
        (generation) => generation === adapter.liveGeneration
      )
  }
}

function renewerFor(
  store: AgentSessionRecordStore,
  probe: ReturnType<typeof pidProbe>,
  clock: { now: number },
  holdsLiveChild: (sessionId: string, fence: number) => boolean
) {
  const log = recordingStructuredAgentSessionLogger()
  const renewer = new StructuredAgentSessionLeaseRenewer({
    store,
    probe,
    holdsLiveChild,
    now: () => clock.now,
    logger: log.logger
  })
  return { renewer, log }
}

describe.each(['darwin', 'win32'] as const)('lease renewal of a held child on %s', (platform) => {
  it('keeps renewing a held child with no start time, without a PID probe', async () => {
    const { store, fence } = await liveStoreWithoutStartTime()
    const { holdsLiveChild } = hostWith({ generation: 'gen-1', fence, phase: 'ready' })
    const probe = pidProbe(platform)
    const clock = { now: NOW + 10_000 }
    const { renewer, log } = renewerFor(store, probe, clock, holdsLiveChild)

    await renewer.renewNow()
    clock.now = NOW + 20_000
    await renewer.renewNow()

    expect(probe).not.toHaveBeenCalled()
    expect(store.getRecord(SESSION)?.lease.lastRenewedAt).toBe(NOW + 20_000)
    expect(log.entries).toEqual([])
  })

  it('stops renewing the moment the adapter sees the root exit', async () => {
    const { store, fence } = await liveStoreWithoutStartTime()
    const { adapter, holdsLiveChild } = hostWith({ generation: 'gen-1', fence, phase: 'ready' })
    const probe = pidProbe(platform)
    const clock = { now: NOW + 10_000 }
    const { renewer } = renewerFor(store, probe, clock, holdsLiveChild)
    await renewer.renewNow()

    // Adapter exit evidence must override a still-indexed host child.
    adapter.liveGeneration = null
    clock.now = NOW + 20_000
    await renewer.renewNow()

    expect(probe).toHaveBeenCalledOnce()
    expect(store.getRecord(SESSION)?.lease.lastRenewedAt).toBe(NOW + 10_000)
  })

  it('dates a crash death to the last held renewal, not to the spawn', async () => {
    const { root, store, fence } = await liveStoreWithoutStartTime()
    const { holdsLiveChild } = hostWith({ generation: 'gen-1', fence, phase: 'ready' })
    const clock = { now: NOW + 10_000 }
    const { renewer } = renewerFor(store, pidProbe(platform), clock, holdsLiveChild)
    await renewer.renewNow()
    clock.now = NOW + 20_000
    await renewer.renewNow()

    const reopened = await openTestAgentSessionRecordStore(root)
    await reopened.reconcileOnRestart({
      probe: async () => ({ outcome: 'pid-absent' }),
      now: NOW + 600_000
    })

    expect(reopened.getRecord(SESSION)?.lease.deathEvidence).toMatchObject({
      kind: 'pid-absent',
      lastProvenAliveAt: NOW + 20_000
    })
  })

  it('still probes a record this runtime does not hold at its fence', async () => {
    const { store, fence } = await liveStoreWithoutStartTime()
    for (const child of [
      { generation: 'gen-0', fence: fence - 1, phase: 'ready' } as const,
      { generation: 'gen-2', fence, phase: 'ready' } as const,
      { generation: null, fence, phase: 'ready' } as const,
      null
    ]) {
      const { holdsLiveChild } = hostWith(child)
      const probe = pidProbe(platform)
      const { renewer, log } = renewerFor(store, probe, { now: NOW + 10_000 }, holdsLiveChild)

      await renewer.renewNow()

      expect(probe).toHaveBeenCalledOnce()
      await expect(probe.mock.results[0]?.value).resolves.toMatchObject({
        outcome: 'indeterminate'
      })
      expect(store.getRecord(SESSION)?.lease.lastRenewedAt).toBe(NOW)
      expect(log.entries.map((entry) => entry.fields)).toContainEqual({
        scope: 'lease-renewal',
        sessionId: SESSION,
        error: expect.objectContaining({ message: 'agent_session_ownership_unknown' })
      })
    }
  })
})
