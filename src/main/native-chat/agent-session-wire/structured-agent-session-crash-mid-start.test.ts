// A host that dies while its Codex child is still starting leaves a lease behind. The child's
// identity is committed the moment it spawns, before the handshake, so the next host can stop that
// exact process and start over instead of guessing whether anything is running.

import { cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AGENT_SESSION_MAX_NEW_OPERATION_AGE_MS,
  AGENT_SESSION_OPERATION_FUTURE_SKEW_MS
} from '../../../shared/agent-session-host-authority'
import type { AgentSessionOwnerProbe } from '../../../shared/agent-session-lease-adjudication'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import type { openCodexAppServerConnection } from '../../codex/codex-app-server-connection'
import { adapterFor, fakeCodex } from '../../codex/codex-structured-session-adapter-fixture'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import type { StructuredAgentSessionHostDeps } from './structured-agent-session-host-types'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  hostTestAttachParams,
  hostTestMessage,
  hostTestOperationId,
  resetHostTestOperationIds
} from './structured-agent-session-host-test-data'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import { createStructuredAgentSessionLogger } from './structured-agent-session-logger'
import { NO_STRUCTURED_AGENTS } from './structured-agent-session-adapter-router-test-support'

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

type HostGeneration = 'dying' | 'relaunched'

/** Each generation's files. The relaunch opens a copy taken at the crash: the dying host stays in
 *  this process with its attach still pending, and a dead process writes nothing after it dies. */
function generationRoot(generation: HostGeneration): string {
  return join(root, generation)
}

async function crash(dying: AgentSessionRecordStore): Promise<void> {
  // An empty renewal queues behind every write the dying host committed, so they are on disk.
  await dying.renewLeases([])
  await cp(generationRoot('dying'), generationRoot('relaunched'), {
    recursive: true,
    // A write still in flight at the crash never landed, and a dead process holds no lock.
    filter: (source) => !source.endsWith('.tmp') && !source.includes('.lock')
  })
}

function openStore(generation: HostGeneration): Promise<AgentSessionRecordStore> {
  return openTestAgentSessionRecordStore(generationRoot(generation))
}

/** A Codex adapter whose child spawns, reports its pid (the fake's `CHILD_PID`) the way the real
 *  connection does, and then never answers the thread handshake: the host dies in that window. */
function adapterThatNeverFinishesStarting(): StructuredAgentSessionAdapter {
  const codex = fakeCodex({
    'thread/start': () => new Promise(() => {}),
    'thread/resume': () => new Promise(() => {})
  })
  return Object.assign(adapterFor(codex), { supportsCreate: () => true })
}

/** A Codex adapter whose child spawns and reports its pid, and whose acquire never answers: the
 *  host dies with the child recorded and the create still unanswered. */
function adapterThatNeverAnswersItsSpawn(): StructuredAgentSessionAdapter {
  const codex = fakeCodex()
  const openConnection: typeof openCodexAppServerConnection = async (launch, handlers = {}) => {
    await codex.openConnection(launch, handlers)
    return new Promise(() => {})
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
  generation: HostGeneration,
  store: AgentSessionRecordStore,
  adapter: StructuredAgentSessionAdapter,
  overrides: Partial<StructuredAgentSessionHostDeps> = {}
): StructuredAgentSessionHost {
  return new StructuredAgentSessionHost({
    agents: NO_STRUCTURED_AGENTS,
    logger: createStructuredAgentSessionLogger(),
    store,
    adapter,
    journalDatabase: openTestJournalHostDatabase(generationRoot(generation)),
    claimKeyId: 'key-1',
    mintSpawnToken: () => 'spawn-a',
    now: () => NOW,
    ...overrides
  })
}

describe('a host that dies while its Codex child is starting', () => {
  it('leaves the spawned child recorded, so the next host stops it by identity and starts over', async () => {
    const first = await openStore('dying')
    const dying = host('dying', first, adapterThatNeverFinishesStarting())
    void dying.attach(CALLER, hostTestAttachParams(null)).catch(() => {})
    // Durable before the handshake returned, which never does: the only record the next host will
    // have. The child is published at spawn, so its lease is already live while it starts.
    await vi.waitFor(() =>
      expect(first.getRecord(SESSION)?.lease).toMatchObject({
        claimStatus: 'live',
        handoffStage: null,
        ownerProcess: { pid: CHILD_PID, spawnToken: 'spawn-a' }
      })
    )

    // The relaunch. The orphan is still alive until something stops it.
    let orphanAlive = true
    const stopOwnerProcess = vi.fn(() => {
      orphanAlive = false
    })
    const restarted = fakeCodex()
    await crash(first)
    const store = await openStore('relaunched')
    const relaunched = host(
      'relaunched',
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
    // What the next send's delivery does: start at the record's current fence.
    const fence = store.getRecord(SESSION)?.lease.runtimeFence ?? null
    expect(await relaunched.attach(CALLER, hostTestAttachParams(fence))).toMatchObject({ ok: true })
    expect(restarted.connections).toHaveLength(1)
    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      claimStatus: 'live',
      ownerProcess: { spawnToken: 'spawn-b' }
    })
  })
})

// The client keeps a create it never heard back from and retries it under the same operation id, so
// that replay, not a fresh start, is what the user's Retry and first send go through.
describe('a create replayed after the host that ran it died', () => {
  const PAST_OPERATION_EXPIRY =
    AGENT_SESSION_MAX_NEW_OPERATION_AGE_MS + AGENT_SESSION_OPERATION_FUTURE_SKEW_MS + 60_000

  it.each([
    ['its child was recorded', adapterThatNeverAnswersItsSpawn, 0],
    [
      'its child was recorded, and its operation row has since expired',
      adapterThatNeverAnswersItsSpawn,
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
    const first = await openStore('dying')
    const dying = host('dying', first, dyingAdapter())
    void dying.attach(CALLER, params).catch(() => {})
    await vi.waitFor(() =>
      expect(first.getRecord(SESSION)?.lease).toMatchObject(
        dyingAdapter === adapterThatNeverSpawns
          ? { claimStatus: 'reserved' }
          : { claimStatus: 'reserved', ownerProcess: { pid: CHILD_PID } }
      )
    )

    const restarted = fakeCodex()
    await crash(first)
    const store = await openStore('relaunched')
    const relaunched = host(
      'relaunched',
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

    const replayed = await relaunched.attach(CALLER, params)
    // Before, `agent_session_ownership_unknown` while the row was pending, then `_operation_expired`.
    expect(replayed.ok ? null : replayed.refusal.code).toBeNull()
    expect(replayed).toMatchObject({ ok: true, value: { sessionId: SESSION, fence: 3 } })
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

// The dying host answered the create at spawn, but the answer was lost on its way to the client.
describe('a create answered before the host that ran it died', () => {
  it('replays that answer with the chat at rest, and the next send starts the agent', async () => {
    const params = hostTestAttachParams(null)
    const first = await openStore('dying')
    const dying = host('dying', first, adapterThatNeverFinishesStarting())
    await expect(dying.attach(CALLER, params)).resolves.toMatchObject({ ok: true })

    const restarted = fakeCodex()
    await crash(first)
    const store = await openStore('relaunched')
    const relaunched = host(
      'relaunched',
      store,
      Object.assign(adapterFor(restarted), { supportsCreate: () => true }),
      { mintSpawnToken: () => 'spawn-b', probeOwner: async () => ({ outcome: 'pid-absent' }) }
    )
    await relaunched.restoreReadableSessions()
    expect(store.getRecord(SESSION)?.lease).toMatchObject({ claimStatus: 'released' })

    // Before, `ownerUnproven`: the replay tried to start an agent from a reservation long gone.
    await expect(relaunched.attach(CALLER, params)).resolves.toMatchObject({
      ok: true,
      replayed: true,
      value: { sessionId: SESSION, fence: 2 }
    })
    expect(restarted.connections).toHaveLength(0)

    const body = hostTestMessage('after the lost answer')
    const sent = await relaunched.send(CALLER, {
      envelope: {
        sessionId: SESSION,
        clientOperationId: hostTestOperationId(),
        expectedRuntimeFence: 2,
        payloadFingerprint: computeAgentSessionPayloadFingerprint({
          method: 'agentSession.send',
          sessionId: SESSION,
          fields: { body }
        })
      },
      body
    })
    expect(sent).toMatchObject({ ok: true })
    await vi.waitFor(() => expect(restarted.connections).toHaveLength(1))
    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      claimStatus: 'live',
      ownerProcess: { spawnToken: 'spawn-b' }
    })
  })
})
