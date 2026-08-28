// End-to-end exits from latched recovery states: no shape a user cannot get out of.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { spawnProcess } from '../../../shared/child-process/run-process'
import { CODEX_SPAWN_TOKEN_ENV } from '../../codex/codex-structured-owner-identity'
import { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { readProcessStartTimeMs } from '../../runtime/agent-session-process-identity-probe'
import { createStructuredAgentSessionOwnerProbe } from '../../runtime/structured-agent-session-runtime'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import type { StructuredAgentSessionHostDeps } from './structured-agent-session-host-types'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD,
  hostTestAttachParams,
  resetHostTestOperationIds
} from './structured-agent-session-host-test-data'

const CALLER = { callerKey: 'client-1' }

let root: string
let store: AgentSessionRecordStore
let host: StructuredAgentSessionHost
let acquire: Mock<StructuredAgentSessionAdapter['acquire']>
const spawnedOwners = new Set<ReturnType<typeof spawnProcess>>()
const supersededHosts = new Set<StructuredAgentSessionHost>()

async function spawnOwner(spawnToken: string) {
  const child = spawnProcess({
    program: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1_000)'],
    env: { ...process.env, [CODEX_SPAWN_TOKEN_ENV]: spawnToken }
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

function adapter(): StructuredAgentSessionAdapter {
  return {
    acquire,
    releaseAcquisition: vi.fn(async () => undefined),
    dispatch: vi.fn(),
    cancelTurn: vi.fn(),
    answerPrompt: vi.fn(),
    setOption: vi.fn()
  } as unknown as StructuredAgentSessionAdapter
}

function openHost(overrides: Partial<StructuredAgentSessionHostDeps> = {}): void {
  host = new StructuredAgentSessionHost({
    store,
    adapter: adapter(),
    journalRoot: root,
    claimKeyId: 'key-1',
    mintSpawnToken: () => 'spawn-a',
    now: () => NOW,
    ...overrides
  })
}

async function reopenStore(): Promise<void> {
  await host.flushAllStreamedEvents()
  store = await AgentSessionRecordStore.open({ directory: join(root, 'store'), hostId: 'local' })
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-recovery-exits-'))
  resetHostTestOperationIds()
  acquire = vi.fn(async ({ fence }) => ({
    process: {
      hostId: 'local',
      pid: 4242,
      processStartTimeMs: 1_700_000_000_000,
      spawnToken: store.getRecord(SESSION)?.lease.reservedSpawnToken ?? 'spawn-a'
    },
    link: {
      linkId: `link-${fence}`,
      handle: { provider: 'codex', threadId: THREAD },
      origin: store.getRecord(SESSION)?.providerHandleChain.length ? 'resumed' : 'created',
      mintedAtFence: fence,
      observedAt: NOW
    }
  }))
  store = await AgentSessionRecordStore.open({ directory: join(root, 'store'), hostId: 'local' })
  openHost()
})

afterEach(async () => {
  await host.flushAllStreamedEvents()
  await Promise.all([...supersededHosts].map((superseded) => superseded.flushAllStreamedEvents()))
  supersededHosts.clear()
  await Promise.all([...spawnedOwners].map((child) => stopOwner(child)))
  await rm(root, { recursive: true, force: true })
})

describe('recovery exits', () => {
  it('frees a reservation stranded by a crash between reserve and identity commit', async () => {
    acquire.mockRejectedValueOnce(new Error('simulated crash before identity commit'))
    await expect(host.attach(CALLER, hostTestAttachParams(null))).rejects.toThrow('simulated crash')
    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      claimStatus: 'reserved',
      ownerProcess: null
    })

    await reopenStore()
    openHost({ mintSpawnToken: () => 'spawn-b' })

    // The abandoned reservation is released at reconcile, so the stale client fence gets
    // a retryable refusal that names the current fence instead of a dead-end latch.
    const stale = await host.attach(CALLER, hostTestAttachParams(1))
    expect(stale).toMatchObject({
      ok: false,
      refusal: { code: 'agent_session_checkpoint_stale', currentFence: 2 }
    })
    const retried = await host.attach(CALLER, hostTestAttachParams(2))
    expect(retried).toMatchObject({ ok: true })
    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      claimStatus: 'live',
      handoffStage: null,
      ownerProcess: { pid: 4242 }
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
    // A fresh child was spawned; the orphan pid's lease did not survive as the owner.
    expect(acquire).toHaveBeenCalledTimes(2)
    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      runtimeFence: 3,
      claimStatus: 'live',
      handoffStage: null
    })
  })

  it('heals a stranded native owner during startup restore, and spawns nothing until a surface asks', async () => {
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

    // Healing is startup's job; spawning is not. The orphan is stopped and the lease is free, but
    // nothing has asked to look at this session, so no replacement child exists yet.
    expect(stopOwnerProcess).toHaveBeenCalledWith(4242, 'SIGTERM')
    expect(acquire).toHaveBeenCalledTimes(1)
    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      claimStatus: 'released',
      handoffStage: null,
      ownerProcess: null
    })

    await host.hold(SESSION, 'surface-1')

    expect(acquire).toHaveBeenCalledTimes(2)
    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      runtimeFence: 3,
      claimStatus: 'live',
      handoffStage: null,
      ownerProcess: { spawnToken: 'spawn-b' }
    })
  })

  it('recovers when the outgoing runtime writes after the replacement probes its dying owner', async () => {
    const outgoing = await spawnOwner('spawn-a')
    acquire.mockResolvedValueOnce({
      process: outgoing.process,
      link: {
        linkId: 'link-outgoing',
        handle: { provider: 'codex', threadId: THREAD },
        origin: 'created',
        mintedAtFence: 1,
        observedAt: NOW
      }
    })
    expect((await host.attach(CALLER, hostTestAttachParams(null))).ok).toBe(true)

    const outgoingHost = host
    const outgoingStore = store
    supersededHosts.add(outgoingHost)
    store = await AgentSessionRecordStore.open({ directory: join(root, 'store'), hostId: 'local' })
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

    const replacement = await spawnOwner('spawn-b')
    acquire.mockResolvedValueOnce({
      process: replacement.process,
      link: {
        linkId: 'link-replacement',
        handle: { provider: 'codex', threadId: THREAD },
        origin: 'resumed',
        mintedAtFence: 3,
        observedAt: NOW + 2
      }
    })

    await host.hold(SESSION, 'surface-overlap')

    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      runtimeFence: 3,
      claimStatus: 'live',
      handoffStage: null,
      ownerProcess: { pid: replacement.process.pid, spawnToken: 'spawn-b' }
    })
    expect(host.history({ sessionId: SESSION, direction: 'tail' }).ok).toBe(true)
  })
})
