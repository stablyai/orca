// End-to-end exits from latched recovery states: no shape a user cannot get out of.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { spawnProcess } from '../../../shared/child-process/run-process'
import { CODEX_SPAWN_TOKEN_ENV } from '../../codex/codex-structured-owner-identity'
import { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { readProcessStartTimeMs } from '../../runtime/agent-session-process-identity-probe'
import { createStructuredAgentSessionOwnerProbe } from '../../runtime/structured-agent-session-owner-probe'
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

/** What a send's delivery or `agentSession.ensure` does: attach at the record's current fence. */
async function startAgent(): Promise<void> {
  const fence = store.getRecord(SESSION)?.lease.runtimeFence ?? null
  expect((await host.attach(CALLER, hostTestAttachParams(fence))).ok).toBe(true)
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

async function abandonHost(abandonedHost: StructuredAgentSessionHost): Promise<void> {
  abandonedHost['runtimeState'].stopLeaseRenewal()
  abandonedHost['lifetime'].dispose()
  await Promise.all(
    [...abandonedHost['sessions'].values()].map((session) => session.journal.close())
  )
  abandonedHost['sessions'].clear()
}

async function reopenStore(): Promise<void> {
  await abandonHost(host)
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
  await abandonHost(host)
  await Promise.all([...supersededHosts].map(abandonHost))
  supersededHosts.clear()
  await Promise.all([...spawnedOwners].map((child) => stopOwner(child)))
  await rm(root, { recursive: true, force: true })
})

describe('recovery exits', () => {
  it('keeps an ownerless unproven acquisition in manual recovery across restart', async () => {
    acquire.mockRejectedValueOnce(new Error('simulated crash before identity commit'))
    await expect(host.attach(CALLER, hostTestAttachParams(null))).rejects.toThrow(
      'agent_session_acquisition_exit_unproven'
    )
    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      claimStatus: 'reserved',
      handoffStage: 'manual-recovery',
      handoffOperationId: null,
      ownerProcess: null,
      runtimeFence: 1,
      reservedSpawnToken: 'spawn-a'
    })

    await reopenStore()
    openHost({ mintSpawnToken: () => 'spawn-b' })

    const refused = await host.attach(CALLER, hostTestAttachParams(1))
    expect(refused).toMatchObject({
      ok: false,
      refusal: { code: 'agent_session_ownership_unknown' }
    })
    expect(acquire).toHaveBeenCalledOnce()
  })

  it('releases an unproven acquisition whose owner later dies, without replaying it as a handoff', async () => {
    // A real session first, so restart restore has a journal to read and runs the
    // handoff restorer over the residue instead of skipping the record.
    expect((await host.attach(CALLER, hostTestAttachParams(null))).ok).toBe(true)
    await reopenStore()

    // The resume fails at owner proof and cleanup cannot prove exit: the settlement
    // keeps the reservation latched at `recovering` with its committed owner identity.
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

    // The unproven owner dies before the next launch; reconciliation and handoff restore run.
    await reopenStore()
    openHost({
      mintSpawnToken: () => 'spawn-c',
      probeOwner: async () => ({ outcome: 'pid-absent' })
    })
    await host.restoreStartupSessions()

    // Death proof releases the residue outright: no handoff continuation, no spawned child,
    // no stage a user would have to clear by hand.
    expect(acquire).toHaveBeenCalledTimes(2)
    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      claimStatus: 'released',
      handoffStage: null,
      handoffOperationId: null,
      ownerProcess: null,
      reservedSpawnToken: null,
      runtimeFence: 4
    })

    // The ordinary native recovery path remains: the next start resumes it.
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
    // A fresh child was spawned; the orphan pid's lease did not survive as the owner.
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

    await host.restoreStartupSessions()

    // Healing is startup's job; spawning is not. The orphan is stopped and the lease is free, but
    // nothing has asked this session for work, so no replacement child exists yet.
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

    await host.restoreStartupSessions()
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
