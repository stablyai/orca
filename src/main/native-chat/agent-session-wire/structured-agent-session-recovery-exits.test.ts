import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { spawnProcess } from '@orca/process-host'
import { ORCA_AGENT_SESSION_SPAWN_TOKEN_ENV } from '../../../shared/agent-session-caller-env'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import { readProcessStartTimeMs } from '../../runtime/agent-session/ownership/agent-session-process-identity-probe'
import { createStructuredAgentSessionOwnerProbe } from '../../runtime/structured-agent-session-owner-probe'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import { abandonStructuredAgentSessionHost } from './structured-agent-session-host-test-abandon'
import type { StructuredAgentSessionHostDeps } from './structured-agent-session-host-types'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD,
  hostTestAttachParams,
  resetHostTestOperationIds
} from './structured-agent-session-host-test-data'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import { createStructuredAgentSessionLogger } from './structured-agent-session-logger'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { NO_STRUCTURED_AGENTS } from './structured-agent-session-adapter-router-test-support'

const CALLER = { callerKey: 'client-1' }

let root: string
let store: AgentSessionRecordStore
let host: StructuredAgentSessionHost
let acquire: Mock<StructuredAgentSessionAdapter['acquire']>
const spawnedOwners = new Set<ReturnType<typeof spawnProcess>>()
const supersededHosts = new Set<StructuredAgentSessionHost>()

async function acquireOwner(spawnToken: string) {
  const child = spawnProcess({
    program: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1_000)'],
    env: { ...process.env, [ORCA_AGENT_SESSION_SPAWN_TOKEN_ENV]: spawnToken }
  })
  spawnedOwners.add(child)
  const pid = child.pid
  if (!pid) {
    throw new Error('owner process did not start')
  }
  const processStartTimeMs = await readProcessStartTimeMs(pid)
  if (processStartTimeMs === null) {
    throw new Error('owner process start time was unavailable')
  }
  return {
    child,
    process: { hostId: 'local', pid, processStartTimeMs, spawnToken }
  }
}

async function stopOwner(child: ReturnType<typeof spawnProcess>): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) {
    const closed = new Promise<void>((resolve) => child.once('close', () => resolve()))
    child.kill('SIGTERM')
    await closed
  }
  spawnedOwners.delete(child)
}

async function startAgent(): Promise<void> {
  const fence = store.getRecord(SESSION)?.lease.runtimeFence ?? null
  expect((await host.attach(CALLER, hostTestAttachParams(fence))).ok).toBe(true)
}

function adapter(): StructuredAgentSessionAdapter {
  return {
    open: async () => ({
      reportedOptions: { model: '' }
    }),
    acquire,
    releaseAcquisition: vi.fn(async () => false),
    dispatch: vi.fn(),
    cancelTurn: vi.fn(),
    answerPrompt: vi.fn(),
    setOption: vi.fn()
  }
}

function openHost(overrides: Partial<StructuredAgentSessionHostDeps> = {}): void {
  host = new StructuredAgentSessionHost({
    agents: NO_STRUCTURED_AGENTS,
    logger: createStructuredAgentSessionLogger(),
    store,
    adapter: adapter(),
    journalDatabase: openTestJournalHostDatabase(root),
    claimKeyId: 'key-1',
    mintSpawnToken: () => 'spawn-a',
    now: () => NOW,
    ...overrides
  })
}

async function reopenStore(): Promise<void> {
  await abandonStructuredAgentSessionHost(host)
  store = await openTestAgentSessionRecordStore(root)
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-recovery-exits-'))
  resetHostTestOperationIds()
  acquire = vi.fn(async ({ fence }) => ({
    acquisitionGeneration: globalThis.crypto.randomUUID(),
    process: {
      hostId: 'local',
      pid: 4242,
      processStartTimeMs: 1_700_000_000_000,
      spawnToken: store.getRecord(SESSION)?.lease.reservedSpawnToken ?? 'spawn-a'
    },
    link: {
      linkId: `link-${fence}`,
      handle: codexProviderHandle(THREAD),
      origin: store.getRecord(SESSION)?.providerHandleChain.length ? 'resumed' : 'created',
      mintedAtFence: fence,
      observedAt: NOW
    }
  }))
  store = await openTestAgentSessionRecordStore(root)
  openHost()
})

afterEach(async () => {
  await abandonStructuredAgentSessionHost(host)
  await Promise.all([...supersededHosts].map(abandonStructuredAgentSessionHost))
  supersededHosts.clear()
  await Promise.all([...spawnedOwners].map((child) => stopOwner(child)))
  await rm(root, { recursive: true, force: true })
})

describe('recovery exits', () => {
  it('releases an ownerless unproven acquisition, so the next start goes ahead', async () => {
    acquire.mockRejectedValueOnce(new Error('simulated crash before identity commit'))
    await expect(host.attach(CALLER, hostTestAttachParams(null))).rejects.toThrow(
      'agent_session_acquisition_exit_unproven'
    )
    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      claimStatus: 'released',
      handoffStage: null,
      handoffOperationId: null,
      ownerProcess: null,
      runtimeFence: 2,
      reservedSpawnToken: null,
      deathEvidence: null
    })

    await reopenStore()
    openHost({ mintSpawnToken: () => 'spawn-b' })

    expect(await host.attach(CALLER, hostTestAttachParams(2))).toMatchObject({ ok: true })
    expect(acquire).toHaveBeenCalledTimes(2)
  })

  it('releases an unproven acquisition whose owner later dies, without replaying it as a handoff', async () => {
    // Seed readable history so restore processes the failed acquisition’s residue.
    expect((await host.attach(CALLER, hostTestAttachParams(null))).ok).toBe(true)
    await reopenStore()

    // Failed owner proof without cleanup proof leaves the committed reservation recovering.
    vi.spyOn(store, 'proveOwner').mockRejectedValueOnce(new Error('handle proof lost'))
    openHost({
      mintSpawnToken: () => 'spawn-b',
      probeOwner: async () => ({ outcome: 'pid-absent' })
    })
    await expect(host.attach(CALLER, hostTestAttachParams(2))).rejects.toThrow(
      'agent_session_acquisition_exit_unproven'
    )
    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      claimStatus: 'reserved',
      handoffStage: 'recovering',
      handoffOperationId: null,
      ownerProcess: { spawnToken: 'spawn-b' },
      runtimeFence: 3,
      reservedSpawnToken: 'spawn-b'
    })

    await reopenStore()
    openHost({
      mintSpawnToken: () => 'spawn-c',
      probeOwner: async () => ({ outcome: 'pid-absent' })
    })
    await host.restoreReadableSessions()

    expect(acquire).toHaveBeenCalledTimes(2)
    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      claimStatus: 'released',
      handoffStage: null,
      handoffOperationId: null,
      ownerProcess: null,
      reservedSpawnToken: null,
      runtimeFence: 4
    })

    await startAgent()
    expect(acquire).toHaveBeenCalledTimes(3)
    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      claimStatus: 'live',
      handoffStage: null,
      runtimeFence: 5,
      ownerProcess: { spawnToken: 'spawn-c' }
    })
  })

  it('stops a surviving native child after restart instead of readopting its dead transport', async () => {
    expect((await host.attach(CALLER, hostTestAttachParams(null))).ok).toBe(true)
    await reopenStore()

    let orphanAlive = true
    const stopOwnerProcess = vi.fn((_pid: number, _signal: 'SIGTERM' | 'SIGKILL') => {
      orphanAlive = false
    })
    openHost({
      mintSpawnToken: () => 'spawn-b',
      probeOwner: async () =>
        orphanAlive
          ? { outcome: 'identity-matched', matchedOn: ['process-start-time'] }
          : { outcome: 'pid-absent' },
      stopOwnerProcess
    })

    const stale = await host.attach(CALLER, hostTestAttachParams(1))
    expect(stale).toMatchObject({
      ok: false,
      refusal: { code: 'agent_session_checkpoint_stale', currentFence: 2 }
    })
    expect(stopOwnerProcess).toHaveBeenCalledWith(4242, 'SIGTERM')
    const retried = await host.attach(CALLER, hostTestAttachParams(2))
    expect(retried).toMatchObject({ ok: true })
    expect(acquire).toHaveBeenCalledTimes(2)
    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      runtimeFence: 3,
      claimStatus: 'live',
      handoffStage: null
    })
  })

  it('heals a stranded native owner during startup restore, and spawns nothing until work asks', async () => {
    expect((await host.attach(CALLER, hostTestAttachParams(null))).ok).toBe(true)
    await reopenStore()

    let orphanAlive = true
    const stopOwnerProcess = vi.fn(() => {
      orphanAlive = false
    })
    openHost({
      mintSpawnToken: () => 'spawn-b',
      probeOwner: async () =>
        orphanAlive
          ? { outcome: 'identity-matched', matchedOn: ['process-start-time'] }
          : { outcome: 'pid-absent' },
      stopOwnerProcess
    })

    await host.restoreReadableSessions()

    // Startup heals ownership without spawning; only later work starts a replacement child.
    expect(stopOwnerProcess).toHaveBeenCalledWith(4242, 'SIGTERM')
    expect(acquire).toHaveBeenCalledTimes(1)
    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      claimStatus: 'released',
      handoffStage: null,
      ownerProcess: null
    })

    await startAgent()

    expect(acquire).toHaveBeenCalledTimes(2)
    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      runtimeFence: 3,
      claimStatus: 'live',
      handoffStage: null,
      ownerProcess: { spawnToken: 'spawn-b' }
    })
  })

  it('recovers when the outgoing runtime writes after the replacement probes its dying owner', async () => {
    const outgoing = await acquireOwner('spawn-a')
    acquire.mockResolvedValueOnce({
      acquisitionGeneration: globalThis.crypto.randomUUID(),
      process: outgoing.process,
      link: {
        linkId: 'link-outgoing',
        handle: codexProviderHandle(THREAD),
        origin: 'created',
        mintedAtFence: 1,
        observedAt: NOW
      }
    })
    expect((await host.attach(CALLER, hostTestAttachParams(null))).ok).toBe(true)

    const outgoingHost = host
    const outgoingStore = store
    supersededHosts.add(outgoingHost)
    store = await openTestAgentSessionRecordStore(root)
    const realProbe = createStructuredAgentSessionOwnerProbe('local')
    let overlapDriven = false
    openHost({
      mintSpawnToken: () => 'spawn-b',
      probeOwner: async (record) => {
        const probe = await realProbe(record)
        if (!overlapDriven) {
          overlapDriven = true
          await outgoingStore.renewLease({
            sessionId: SESSION,
            fence: 1,
            childProbe: probe,
            now: NOW + 1
          })
          await stopOwner(outgoing.child)
        }
        return probe
      }
    })

    await host.restoreReadableSessions()
    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      runtimeFence: 2,
      claimStatus: 'released',
      ownerProcess: null
    })
    expect(acquire).toHaveBeenCalledOnce()

    const replacement = await acquireOwner('spawn-b')
    acquire.mockResolvedValueOnce({
      acquisitionGeneration: globalThis.crypto.randomUUID(),
      process: replacement.process,
      link: {
        linkId: 'link-replacement',
        handle: codexProviderHandle(THREAD),
        origin: 'resumed',
        mintedAtFence: 3,
        observedAt: NOW + 2
      }
    })

    await startAgent()

    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      runtimeFence: 3,
      claimStatus: 'live',
      handoffStage: null,
      ownerProcess: { pid: replacement.process.pid, spawnToken: 'spawn-b' }
    })
    expect((await host.history({ sessionId: SESSION, direction: 'tail' })).ok).toBe(true)
  })
})
