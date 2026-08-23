// End-to-end exits from latched recovery states: no shape a user cannot get out of.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
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

  it('heals a stranded native owner during startup restore without waiting for a client', async () => {
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

    expect(stopOwnerProcess).toHaveBeenCalledWith(4242, 'SIGTERM')
    expect(acquire).toHaveBeenCalledTimes(2)
    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      runtimeFence: 3,
      claimStatus: 'live',
      handoffStage: null,
      ownerProcess: { spawnToken: 'spawn-b' }
    })
  })
})
