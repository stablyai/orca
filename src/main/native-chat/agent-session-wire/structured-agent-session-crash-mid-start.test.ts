import { openTestChats } from './structured-agent-session-open-test-chats.test-support'
// Persist spawn identity before handshake so relaunch can stop the exact orphan instead of guessing.

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
import {
  closeTestJournalHostDatabases,
  openTestJournalHostDatabase
} from '../agent-session-journal/journal-host-database-test-support'
import { createStructuredAgentSessionLogger } from './structured-agent-session-logger'
import { NO_STRUCTURED_AGENTS } from './structured-agent-session-adapter-router-test-support'
import * as journalFactory from '../agent-session-journal/journal-store-factory'

const CALLER = { callerKey: 'client-1' }
const CHILD_PID = 4321

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-crash-mid-start-'))
  resetHostTestOperationIds()
})

afterEach(async () => {
  await closeTestJournalHostDatabases()
  await rm(root, { recursive: true, force: true })
})

type HostGeneration = 'dying' | 'relaunched'

/** Relaunch from a crash-time copy; the still-pending dying host cannot write into it. */
function generationRoot(generation: HostGeneration): string {
  return join(root, generation)
}

async function crash(dying: AgentSessionRecordStore): Promise<void> {
  // Empty renewal drains preceding durable store writes before copying.
  await dying.renewLeases([])
  await cp(generationRoot('dying'), generationRoot('relaunched'), {
    recursive: true,
    // Exclude uncommitted writes and locks a dead process no longer holds.
    filter: (source) => !source.endsWith('.tmp') && !source.includes('.lock')
  })
}

function openStore(generation: HostGeneration): Promise<AgentSessionRecordStore> {
  return openTestAgentSessionRecordStore(generationRoot(generation))
}

/** Report spawn identity, then hang in thread handshake. */
function adapterThatNeverFinishesStarting(): StructuredAgentSessionAdapter {
  const codex = fakeCodex({
    'thread/start': () => new Promise(() => {}),
    'thread/resume': () => new Promise(() => {})
  })
  return Object.assign(adapterFor(codex), { supportsCreate: () => true })
}

/** Report spawn identity, then hang acquisition before create answers. */
function adapterThatNeverAnswersItsSpawn(): StructuredAgentSessionAdapter {
  const codex = fakeCodex()
  const openConnection: typeof openCodexAppServerConnection = async (launch, handlers = {}) => {
    await codex.openConnection(launch, handlers)
    return new Promise(() => {})
  }
  return Object.assign(adapterFor({ ...codex, openConnection }), { supportsCreate: () => true })
}

/** Leave only a reservation with no observed spawn identity. */
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
    // Spawn proof must be durable while handshake remains unanswered.
    await vi.waitFor(() =>
      expect(first.getRecord(SESSION)?.lease).toMatchObject({
        claimStatus: 'live',
        handoffStage: null,
        ownerProcess: { pid: CHILD_PID, spawnToken: 'spawn-a' }
      })
    )

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
    const openJournal = vi.spyOn(journalFactory, 'openAgentSessionJournal')
    openJournal.mockClear()
    await relaunched.reconcileRestartLeases()
    await relaunched.seedSessionTabs([SESSION])
    expect(openJournal).not.toHaveBeenCalled()
    expect(relaunched.hasSession(SESSION)).toBe(false)
    expect(await relaunched.revealSession(SESSION)).toMatchObject({ readable: true })

    expect(stopOwnerProcess).toHaveBeenCalledWith(CHILD_PID, 'SIGTERM')
    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      claimStatus: 'released',
      handoffStage: null,
      ownerProcess: null,
      deathEvidence: { kind: 'pid-absent' }
    })
    const fence = store.getRecord(SESSION)?.lease.runtimeFence ?? null
    expect(await relaunched.attach(CALLER, hostTestAttachParams(fence))).toMatchObject({ ok: true })
    expect(restarted.connections).toHaveLength(1)
    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      claimStatus: 'live',
      ownerProcess: { spawnToken: 'spawn-b' }
    })
  })
})

// Unknown-outcome creates retry the same operation, including user Retry and first-send recovery.
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
        // Non-Linux hosts cannot scan tokens; missing-PID reservations remain indeterminate.
        probeOwner: async (record): Promise<AgentSessionOwnerProbe> =>
          record.lease.ownerProcess
            ? { outcome: 'pid-absent' }
            : { outcome: 'indeterminate', reason: 'spawn token scan unavailable' },
        now: () => NOW + elapsedMs
      }
    )
    await openTestChats(relaunched)
    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      claimStatus: 'released',
      handoffStage: null,
      runtimeFence: 2
    })

    const replayed = await relaunched.attach(CALLER, params)
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

    await expect(relaunched.attach(CALLER, params)).resolves.toMatchObject({
      ok: true,
      replayed: true
    })
    expect(restarted.connections).toHaveLength(1)
  })
})

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
    await openTestChats(relaunched)
    expect(store.getRecord(SESSION)?.lease).toMatchObject({ claimStatus: 'released' })

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
