// A host that dies while its Codex child is still starting leaves a lease behind. The child's
// identity is committed the moment it spawns, before the handshake, so the next host can stop that
// exact process and start over instead of guessing whether anything is running.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AGENT_SESSION_MAX_NEW_OPERATION_AGE_MS,
  AGENT_SESSION_OPERATION_FUTURE_SKEW_MS
} from '../../../shared/agent-session-host-authority'
import type { AgentSessionOwnerProbe } from '../../../shared/agent-session-lease-adjudication'
import type { openCodexAppServerConnection } from '../../codex/codex-app-server-connection'
import { adapterFor, fakeCodex } from '../../codex/codex-structured-session-adapter-fixture'
import { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import type { StructuredAgentSessionHostDeps } from './structured-agent-session-host-types'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  hostTestAttachParams,
  resetHostTestOperationIds
} from './structured-agent-session-host-test-data'

const CALLER = { callerKey: 'client-1' }
const CHILD_PID = 4321

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-crash-mid-start-'))
  resetHostTestOperationIds()
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function openStore(): Promise<AgentSessionRecordStore> {
  return AgentSessionRecordStore.open({ directory: join(root, 'store'), hostId: 'local' })
}

/** A Codex adapter whose child spawns, reports its pid the way the real connection does, and then
 *  never answers the thread handshake: the host dies in that window. */
function adapterThatNeverFinishesStarting(): StructuredAgentSessionAdapter {
  const codex = fakeCodex({
    'thread/start': () => new Promise(() => {}),
    'thread/resume': () => new Promise(() => {})
  })
  const openConnection: typeof openCodexAppServerConnection = async (launch, handlers = {}) => {
    const connection = await codex.openConnection(launch, handlers)
    await handlers.onSpawned?.(CHILD_PID)
    return connection
  }
  return Object.assign(adapterFor({ ...codex, openConnection }), { supportsCreate: () => true })
}

/** A Codex adapter whose child never gets as far as reporting its pid: the reservation is all the
 *  next host finds. */
function adapterThatNeverSpawns(): StructuredAgentSessionAdapter {
  const codex = fakeCodex()
  const openConnection: typeof openCodexAppServerConnection = () => new Promise(() => {})
  return Object.assign(adapterFor({ ...codex, openConnection }), { supportsCreate: () => true })
}

function host(
  store: AgentSessionRecordStore,
  adapter: StructuredAgentSessionAdapter,
  overrides: Partial<StructuredAgentSessionHostDeps> = {}
): StructuredAgentSessionHost {
  return new StructuredAgentSessionHost({
    store,
    adapter,
    journalRoot: root,
    claimKeyId: 'key-1',
    mintSpawnToken: () => 'spawn-a',
    now: () => NOW,
    ...overrides
  })
}

describe('a host that dies while its Codex child is starting', () => {
  it('leaves the spawned child recorded, so the next host stops it by identity and starts over', async () => {
    const first = await openStore()
    const dying = host(first, adapterThatNeverFinishesStarting())
    void dying.attach(CALLER, hostTestAttachParams(null))
    await vi.waitFor(() => expect(first.getRecord(SESSION)?.lease.ownerProcess).toBeTruthy())
    // Durable before the handshake returned: the only record the next host will have.
    expect(first.getRecord(SESSION)?.lease).toMatchObject({
      claimStatus: 'reserved',
      handoffStage: 'new-owner-proving',
      ownerProcess: { pid: CHILD_PID, spawnToken: 'spawn-a' }
    })

    // The relaunch. The orphan is still alive until something stops it.
    let orphanAlive = true
    const stopOwnerProcess = vi.fn(() => {
      orphanAlive = false
    })
    const restarted = fakeCodex()
    const store = await openStore()
    const relaunched = host(
      store,
      Object.assign(adapterFor(restarted), { supportsCreate: () => true }),
      {
        mintSpawnToken: () => 'spawn-b',
        probeOwner: async () =>
          orphanAlive
            ? { outcome: 'identity-matched', matchedOn: ['spawn-token'] }
            : { outcome: 'pid-absent' },
        stopOwnerProcess
      }
    )
    await relaunched.restoreReadableSessions()

    expect(stopOwnerProcess).toHaveBeenCalledWith(CHILD_PID, 'SIGTERM')
    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      claimStatus: 'released',
      handoffStage: null,
      ownerProcess: null,
      deathEvidence: { kind: 'pid-absent' }
    })
    await relaunched.hold(SESSION, 'desktop-chat:1')
    expect(restarted.connections).toHaveLength(1)
    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      claimStatus: 'live',
      ownerProcess: { spawnToken: 'spawn-b' }
    })
  })
})

// The client keeps a create it never heard back from and retries it under the same operation id, so
// that replay, not a fresh hold, is what the user's Retry and first send go through.
describe('a create replayed after the host that ran it died', () => {
  const PAST_OPERATION_EXPIRY =
    AGENT_SESSION_MAX_NEW_OPERATION_AGE_MS + AGENT_SESSION_OPERATION_FUTURE_SKEW_MS + 60_000

  it.each([
    ['its child was recorded', adapterThatNeverFinishesStarting, 0],
    [
      'its child was recorded, and its operation row has since expired',
      adapterThatNeverFinishesStarting,
      PAST_OPERATION_EXPIRY
    ],
    ['nothing was recorded beyond the reservation', adapterThatNeverSpawns, 0],
    [
      'nothing was recorded, and its operation row has since expired',
      adapterThatNeverSpawns,
      PAST_OPERATION_EXPIRY
    ]
  ] as const)('starts an agent when %s', async (_case, dyingAdapter, elapsedMs) => {
    const params = hostTestAttachParams(null)
    const first = await openStore()
    const dying = host(first, dyingAdapter())
    void dying.attach(CALLER, params)
    await vi.waitFor(() => expect(first.getRecord(SESSION)?.lease.claimStatus).toBe('reserved'))

    const restarted = fakeCodex()
    const store = await openStore()
    const relaunched = host(
      store,
      Object.assign(adapterFor(restarted), { supportsCreate: () => true }),
      {
        mintSpawnToken: () => 'spawn-b',
        // A reservation with no pid probes indeterminate: no token scan off Linux.
        probeOwner: async (record): Promise<AgentSessionOwnerProbe> =>
          record.lease.ownerProcess
            ? { outcome: 'pid-absent' }
            : { outcome: 'indeterminate', reason: 'spawn token scan unavailable' },
        now: () => NOW + elapsedMs
      }
    )
    await relaunched.restoreReadableSessions()
    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      claimStatus: 'released',
      handoffStage: null,
      runtimeFence: 2
    })

    await expect(relaunched.attach(CALLER, params)).resolves.toMatchObject({
      ok: true,
      value: { sessionId: SESSION, fence: 3 }
    })
    expect(restarted.connections).toHaveLength(1)
    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      claimStatus: 'live',
      runtimeFence: 3,
      ownerProcess: { spawnToken: 'spawn-b' }
    })
    expect(
      store.getOperationRow(CALLER.callerKey, params.envelope.clientOperationId)?.outcome
    ).toEqual({ status: 'succeeded', sessionId: SESSION })

    // Settled now: the same id replays that answer and never starts a second agent.
    await expect(relaunched.attach(CALLER, params)).resolves.toMatchObject({
      ok: true,
      replayed: true
    })
    expect(restarted.connections).toHaveLength(1)
  })
})
