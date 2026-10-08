import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { probeAgentSessionProcessIdentity } from '../../runtime/agent-session-process-identity-probe'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import {
  closeTestJournalHostDatabase,
  openTestJournalHostDatabase
} from '../agent-session-journal/journal-host-database-test-support'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import { claudeAndCodexDeclared } from './structured-agent-session-adapter-router-test-support'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD,
  hostTestAttachParams
} from './structured-agent-session-host-test-data'
import { recordingProductionStructuredAgentSessionLogger } from './structured-agent-session-logger-test-support'

const RENEW_INTERVAL_MS = 10_000
const roots: string[] = []

afterEach(async () => {
  vi.useRealTimers()
  for (const root of roots) {
    closeTestJournalHostDatabase(root)
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

/** A real host whose adapter spawned a child it could not read a start time for. */
async function hostWithStartTimeLessChild(platform: NodeJS.Platform) {
  const root = await mkdtemp(join(tmpdir(), 'orca-host-held-renewal-'))
  roots.push(root)
  const store = await openTestAgentSessionRecordStore(root)
  const clock = { now: NOW }
  const process = { live: true }
  const holdsLiveProviderProcess = vi.fn(
    (_sessionId: string, generation: string) => process.live && generation === 'gen-1'
  )
  const adapter: StructuredAgentSessionAdapter = {
    acquire: async ({ fence }) => ({
      process: {
        hostId: 'local',
        pid: 4242,
        processStartTimeMs: null,
        spawnToken: store.getRecord(SESSION)?.lease.reservedSpawnToken ?? 'spawn-a'
      },
      link: {
        linkId: `link-${fence}`,
        handle: codexProviderHandle(THREAD),
        origin: 'created',
        mintedAtFence: fence,
        observedAt: NOW
      },
      acquisitionGeneration: 'gen-1'
    }),
    holdsLiveProviderProcess,
    dispatch: vi.fn(),
    cancelTurn: vi.fn(),
    answerPrompt: vi.fn(),
    setOption: vi.fn()
  }
  // The real PID probe with the pid present: no start time and no token echo to match.
  const probeOwner = vi.fn((record: AgentSessionRecord) =>
    probeAgentSessionProcessIdentity({
      identity: record.lease.ownerProcess!,
      deps: { platform, isPidPresent: () => true }
    })
  )
  const host = new StructuredAgentSessionHost({
    logger: recordingProductionStructuredAgentSessionLogger().logger,
    store,
    adapter,
    agents: claudeAndCodexDeclared(),
    journalDatabase: openTestJournalHostDatabase(root),
    claimKeyId: 'key-1',
    mintSpawnToken: () => 'spawn-a',
    probeOwner,
    now: () => clock.now
  })
  return { host, store, clock, process, probeOwner, holdsLiveProviderProcess }
}

describe.each(['darwin', 'win32'] as const)('host lease renewal on %s', (platform) => {
  it('renews a held child without a PID probe until the adapter sees its root exit', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const { host, store, clock, process, probeOwner, holdsLiveProviderProcess } =
      await hostWithStartTimeLessChild(platform)
    const attached = await host.attach({ callerKey: 'client-1' }, hostTestAttachParams(null))
    expect(attached.ok).toBe(true)
    const fence = store.getRecord(SESSION)!.lease.runtimeFence

    clock.now = NOW + RENEW_INTERVAL_MS
    await vi.advanceTimersByTimeAsync(RENEW_INTERVAL_MS)
    await vi.waitFor(() =>
      expect(store.getRecord(SESSION)?.lease.lastRenewedAt).toBe(NOW + RENEW_INTERVAL_MS)
    )
    expect(probeOwner).not.toHaveBeenCalled()
    expect(holdsLiveProviderProcess).toHaveBeenCalledWith(SESSION, 'gen-1')

    // The adapter saw the root exit; the host has not settled it, so its child is still on record.
    process.live = false
    clock.now = NOW + 2 * RENEW_INTERVAL_MS
    await vi.advanceTimersByTimeAsync(RENEW_INTERVAL_MS)
    await vi.waitFor(() => expect(probeOwner).toHaveBeenCalledOnce())

    expect(store.getRecord(SESSION)?.lease.runtimeFence).toBe(fence)
    expect(store.getRecord(SESSION)?.lease.lastRenewedAt).toBe(NOW + RENEW_INTERVAL_MS)
    await host.flushAllStreamedEvents()
  })
})
