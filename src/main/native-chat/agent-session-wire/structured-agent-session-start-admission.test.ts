import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { AgentSessionOwnerProbe } from '../../../shared/agent-session-lease-adjudication'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { DISPATCH_REJECTED_CANCELLED } from '../../../shared/structured-agent-session-dispatch-rejection'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import { AgentSessionJournal } from '../agent-session-journal/journal-store'
import {
  closeTestJournalHostDatabases,
  openTestJournalHostDatabase
} from '../agent-session-journal/journal-host-database-test-support'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import type { StructuredAgentSessionEventSink } from './structured-agent-session-event-sink'
import { NO_STRUCTURED_AGENTS } from './structured-agent-session-adapter-router-test-support'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD,
  hostTestAttachParams,
  hostTestMessage,
  hostTestOperationId,
  resetHostTestOperationIds
} from './structured-agent-session-host-test-data'
import { createStructuredAgentSessionLogger } from './structured-agent-session-logger'
import { runWithReadyStructuredAgentSessionOperation } from './structured-agent-session-ready-operation'
import { persistRewindRecord } from './structured-rewind-recovery'

const CALLER = { callerKey: 'client-1' }
const PID_ABSENT: AgentSessionOwnerProbe = { outcome: 'pid-absent' }
const eventually = (assertion: () => void | Promise<void>) =>
  vi.waitFor(assertion, { timeout: 10_000 })

type Point =
  | 'closing'
  | 'probe'
  | 'reprobe'
  | 'resolver'
  | 'spawn'
  | 'drain'
  | 'open'
  | 'recovery'
  | 'pending-row'
  | 'dispatch'
const holds = new Map<Point, PromiseWithResolvers<void>>()
const reached = new Set<Point>()

async function at(point: Point): Promise<void> {
  const held = holds.get(point)
  if (held) {
    holds.delete(point)
    reached.add(point)
    await held.promise
  }
}

let root: string
let store: AgentSessionRecordStore
let host: StructuredAgentSessionHost
let acquire: Mock<StructuredAgentSessionAdapter['acquire']>
let closeSession: Mock<NonNullable<StructuredAgentSessionAdapter['closeSession']>>
let releaseAcquisition: Mock<NonNullable<StructuredAgentSessionAdapter['releaseAcquisition']>>
let probeOwner: Mock<(record: unknown) => Promise<AgentSessionOwnerProbe>>
let delivered: string[]
let events: StructuredAgentSessionEventSink | undefined
let initialAttach: ReturnType<typeof hostTestAttachParams>
let idleSweep: { intervalMs: number; idleMs: number }

function startHost(): void {
  host = new StructuredAgentSessionHost({
    agents: NO_STRUCTURED_AGENTS,
    logger: createStructuredAgentSessionLogger(),
    store,
    adapter: {
      acquire,
      closeSession,
      releaseAcquisition,
      open: async () => {
        await at('open')
        return { reportedOptions: { model: 'default' } }
      },
      dispatch: async (input) => {
        await at('dispatch')
        input.signal?.throwIfAborted()
        delivered.push(input.clientMessageId)
        const ordinal = delivered.length
        return {
          state: 'accepted',
          providerIdentity: { provider: 'codex', threadId: THREAD, turnId: `t-${ordinal}`, ordinal }
        }
      },
      recoverRewind: async () => {
        await at('recovery')
        return { ok: true, items: [] }
      },
      cancelTurn: vi.fn(async () => ({ cancelled: false })),
      answerPrompt: vi.fn(async () => undefined),
      setOption: vi.fn(async () => undefined)
    },
    journalDatabase: openTestJournalHostDatabase(root),
    claimKeyId: 'key-1',
    mintSpawnToken: () => `spawn-${acquire.mock.calls.length}`,
    probeOwner,
    stopOwnerProcess: vi.fn(),
    resolveLaunchArgs: async () => {
      await at('resolver')
      return undefined
    },
    idleSweep,
    now: () => NOW
  })
  const { runtimeState } = host.collaboratorsForTests()
  const mint = runtimeState.mintEventSink.bind(runtimeState)
  vi.spyOn(runtimeState, 'mintEventSink').mockImplementation((sessionId) => {
    const sink = mint(sessionId)
    const drained = sink.drained.bind(sink)
    sink.drained = async () => {
      await at('drain')
      return drained()
    }
    return sink
  })
}

async function restart(reopen = false): Promise<void> {
  await host.close(SESSION, 'evict')
  await host.flushAllStreamedEvents()
  if (reopen) {
    store = await openTestAgentSessionRecordStore(root)
  }
  startHost()
}

const SETUP: Record<Point, () => Promise<void>> = {
  closing: async () => {
    // Unproven Stop leaves a close for startup to join.
    closeSession.mockResolvedValueOnce(false)
    const { serialize, lifetime } = host.collaboratorsForTests()
    await serialize(SESSION, () => lifetime.stopAgent(SESSION, { cause: 'evict', resting: true }))
      .then(() => undefined)
      .catch(() => undefined)
    closeSession.mockImplementationOnce(async () => {
      await at('closing')
      return true
    })
  },
  probe: () => restart(true).then(() => holdProbes([PID_ABSENT], 0)),
  reprobe: async () => {
    await leaveRecovering()
    holdProbes([{ outcome: 'identity-matched', matchedOn: ['spawn-token'] }, PID_ABSENT], 1)
  },
  resolver: () => restart(),
  spawn: () => restart(),
  drain: () => restart(),
  open: () => restart(),
  recovery: async () => {
    const turn = { provider: 'codex' as const, threadId: THREAD, turnId: 'turn-1', ordinal: 0 }
    events!.appendItem(turn, hostTestMessage('rewound'), { turnScope: AGENT_JOURNAL_THREAD_SCOPE })
    await host.flushStreamedEvents(SESSION)
    const expectedEpoch = (await host.journalSnapshot(SESSION)).cursor.epoch
    await restart()
    await persistRewindRecord(store, SESSION, store.getRecord(SESSION)!.lease.runtimeFence, {
      operationId: 'rewind-op',
      callerKey: 'client-1',
      itemId: agentJournalItemKey(turn),
      providerItemId: agentJournalItemKey(turn),
      expectedEpoch,
      phase: 'prepared'
    })
  },
  'pending-row': async () => {
    await restart()
    const write = AgentSessionJournal.prototype.resolveDispatch
    vi.spyOn(AgentSessionJournal.prototype, 'resolveDispatch').mockImplementation(async function (
      this: AgentSessionJournal,
      ...args
    ) {
      const written = await write.apply(this, args)
      if (args[0].state === 'pending') {
        await at('pending-row')
      }
      return written
    })
  },
  dispatch: () => restart()
}

async function leaveRecovering(): Promise<void> {
  const owner = store.getRecord(SESSION)!.lease.ownerProcess
  await restart()
  await store.transitionHandoff(SESSION, (record) => ({
    ...record,
    lease: { ...record.lease, ownerProcess: owner, handoffStage: 'recovering' }
  }))
}

function holdProbes(answers: AgentSessionOwnerProbe[], heldAt: number): void {
  answers.forEach((answer, index) =>
    probeOwner.mockImplementationOnce(async () => {
      if (index === heldAt) {
        await at(heldAt === 0 ? 'probe' : 'reprobe')
      }
      return answer
    })
  )
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-start-admission-'))
  resetHostTestOperationIds()
  holds.clear()
  reached.clear()
  delivered = []
  idleSweep = { intervalMs: 60 * 60_000, idleMs: 60 * 60_000 }
  acquire = vi.fn(async (input) => {
    events = input.events
    await at('spawn')
    return {
      process: { hostId: 'local', pid: 4242, processStartTimeMs: 1, spawnToken: input.spawnToken },
      acquisitionGeneration: `generation-${acquire.mock.calls.length}`,
      link: {
        linkId: `link-${input.fence}`,
        handle: codexProviderHandle(THREAD),
        origin: store.getRecord(SESSION)?.providerHandleChain.length ? 'resumed' : 'created',
        mintedAtFence: input.fence,
        observedAt: NOW
      }
    }
  })
  closeSession = vi.fn(async () => true)
  releaseAcquisition = vi.fn(async () => true)
  probeOwner = vi.fn(async () => PID_ABSENT)
  store = await openTestAgentSessionRecordStore(root)
  startHost()
  initialAttach = hostTestAttachParams(null)
  expect(await host.attach(CALLER, initialAttach)).toMatchObject({ ok: true })
})

afterEach(async () => {
  for (const held of holds.values()) {
    held.resolve()
  }
  vi.restoreAllMocks()
  await host.flushAllStreamedEvents()
  await closeTestJournalHostDatabases()
  await rm(root, { recursive: true, force: true })
})

function envelope(method: string, fields: Record<string, unknown>) {
  const clientOperationId = hostTestOperationId()
  const payloadFingerprint = computeAgentSessionPayloadFingerprint({
    method,
    sessionId: SESSION,
    fields
  })
  return { sessionId: SESSION, clientOperationId, expectedRuntimeFence: null, payloadFingerprint }
}

function send(text: string) {
  const fields = { body: hostTestMessage(text) }
  const sent = envelope('agentSession.send', fields)
  return { id: sent.clientOperationId, sent: host.send(CALLER, { envelope: sent, ...fields }) }
}

async function submission(id: string) {
  const { submissions } = await host.journalSnapshot(SESSION)
  return submissions.find((entry) => entry.clientMessageId === id)
}

const stop = () => host.cancel(CALLER, { envelope: envelope('agentSession.cancel', {}) })

async function heldAt(point: Point) {
  await SETUP[point]()
  const held = Promise.withResolvers<void>()
  holds.set(point, held)
  const spawned = acquire.mock.calls.length
  const first = send('first')
  await eventually(() => expect(reached.has(point)).toBe(true))
  return { first, release: () => held.resolve(), spawned }
}

const child = () => host.collaboratorsForTests().sessions.get(SESSION)?.child ?? null
const PRE_PUBLISH: readonly Point[] = ['probe', 'reprobe', 'resolver', 'spawn', 'drain']
const POSIX = process.platform !== 'win32'

describe('a send while the agent start is held', () => {
  it.each<{ point: Point; acceptedWhileHeld?: false }>([
    { point: 'closing' },
    { point: 'probe' },
    ...(POSIX ? [{ point: 'reprobe' as const }] : []),
    { point: 'resolver' },
    { point: 'spawn' },
    { point: 'drain' },
    { point: 'open' },
    // Provider-only rewind waits outside serialization before acceptance.
    { point: 'recovery', acceptedWhileHeld: false },
    { point: 'dispatch' }
  ])('at $point is accepted at once and handed over once, in order', async (row) => {
    const { first, release, spawned } = await heldAt(row.point)

    const second = send('second')
    if (row.acceptedWhileHeld !== false) {
      expect(await first.sent).toMatchObject({ ok: true })
      expect(await second.sent).toMatchObject({ ok: true })
      expect(delivered).toEqual([])
    }
    release()

    await eventually(async () =>
      expect((await submission(second.id))?.dispatchState).toBe('accepted')
    )
    expect(delivered).toEqual([first.id, second.id])
    expect(acquire).toHaveBeenCalledTimes(spawned + 1)
    expect(child()).toMatchObject({ phase: 'ready', generation: `generation-${spawned + 1}` })
  })
})

describe('a Stop while the agent start is held', () => {
  it.each<Point>([
    'probe',
    ...(POSIX ? ['reprobe' as const] : []),
    'resolver',
    'spawn',
    'drain',
    'open',
    'recovery',
    'pending-row',
    'dispatch'
  ])('at %s is recorded without waiting, and nothing reaches the provider', async (point) => {
    const { first, release } = await heldAt(point)

    const stopped = stop()
    // Stop’s persistence queues behind pending-row commit; abort itself is immediate.
    if (point !== 'pending-row') {
      expect(await stopped).toMatchObject({ ok: true })
    }
    release()
    expect(await stopped).toMatchObject({ ok: true })

    await eventually(() =>
      expect(host.collaboratorsForTests().runtimeState.startFlights.get(SESSION)).toBeUndefined()
    )
    if (point === 'recovery') {
      expect(await first.sent).toMatchObject({ ok: false })
    } else {
      await eventually(async () =>
        expect(await submission(first.id)).toMatchObject({
          dispatchState: 'rejected',
          reason: DISPATCH_REJECTED_CANCELLED
        })
      )
    }
    expect(delivered).toEqual([])
    if (PRE_PUBLISH.includes(point)) {
      expect(child()).toBeNull()
    }
    if (point === 'spawn' || point === 'drain') {
      await eventually(() => expect(releaseAcquisition).toHaveBeenCalled())
    }
  })
})

describe('a start racing the host', () => {
  it('honors Stop admitted while preparation yields, then starts later work once', async () => {
    await restart()
    const { loop } = host.collaboratorsForTests().conversationDelivery
    const preparation = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    vi.spyOn(loop['deps'], 'retireOutgrownChild').mockImplementationOnce(async () => {
      entered.resolve()
      await preparation.promise
    })
    const spawned = acquire.mock.calls.length
    const first = send('withdraw before claim')
    await entered.promise
    expect(host.collaboratorsForTests().runtimeState.startFlights.has(SESSION)).toBe(false)
    const stopped = stop()
    preparation.resolve()
    expect(await stopped).toMatchObject({ ok: true })
    await eventually(async () =>
      expect((await submission(first.id))?.dispatchState).toBe('rejected')
    )
    await eventually(() =>
      expect(host.collaboratorsForTests().runtimeState.startFlights.has(SESSION)).toBe(false)
    )
    expect(acquire).toHaveBeenCalledTimes(spawned)
    expect(child()).toBeNull()
    const later = send('new demand')
    await eventually(async () =>
      expect((await submission(later.id))?.dispatchState).toBe('accepted')
    )
    expect(delivered).toEqual([later.id])
    expect(acquire).toHaveBeenCalledTimes(spawned + 1)
  })

  it('replays eager attach through the unpublished flight without inventing readiness', async () => {
    const { first, release, spawned } = await heldAt('drain')
    await first.sent
    expect(child()).toBeNull()
    expect(store.getRecord(SESSION)?.lease.claimStatus).toBe('live')
    const opened = Promise.withResolvers<void>()
    holds.set('open', opened)
    let operationRan = false
    const operation = runWithReadyStructuredAgentSessionOperation(
      host['mutationContext'](),
      CALLER.callerKey,
      envelope('agentSession.setOption', {}),
      { method: 'agentSession.setOption', fields: {} },
      async () => {
        operationRan = true
        return {
          ok: true,
          replayed: false,
          fence: child()!.fence,
          cursor: host.collaboratorsForTests().sessions.get(SESSION)!.journal.cursor(),
          value: {}
        }
      }
    )
    let replayed = false
    const replay = host.attach(CALLER, initialAttach).then((result) => {
      replayed = true
      return result
    })
    await host.collaboratorsForTests().serialize(SESSION, async () => {})
    expect(replayed).toBe(false)
    expect(child()).toBeNull()
    release()
    await eventually(() => expect(child()?.phase).toBe('starting'))
    expect(replayed).toBe(false)
    expect(child()).toMatchObject({ phase: 'starting', generation: `generation-${spawned + 1}` })
    expect(operationRan).toBe(false)
    opened.resolve()
    expect(await replay).toMatchObject({ ok: true, replayed: true })
    expect(await operation).toMatchObject({ ok: true })
    expect(operationRan).toBe(true)
    await eventually(async () =>
      expect((await submission(first.id))?.dispatchState).toBe('accepted')
    )
    expect(child()).toMatchObject({ phase: 'ready', generation: `generation-${spawned + 1}` })
    expect(acquire).toHaveBeenCalledTimes(spawned + 1)
  })

  it('spawns nothing when quit lands before the spawn', async () => {
    const { first, release, spawned } = await heldAt('resolver')
    await first.sent

    await host.flushAllStreamedEvents()
    release()

    expect(acquire).toHaveBeenCalledTimes(spawned)
    expect(child()).toBeNull()
  })

  it('starts exactly one child for sends made at once', async () => {
    await restart()
    const spawned = acquire.mock.calls.length
    const sends = ['a', 'b', 'c'].map(send)

    await eventually(async () =>
      expect((await submission(sends[2]!.id))?.dispatchState).toBe('accepted')
    )
    expect(acquire).toHaveBeenCalledTimes(spawned + 1)
    expect(delivered).toEqual(sends.map(({ id }) => id))
  })

  it('clears a lease a failed attempt left recovering, and the start goes ahead', async () => {
    await leaveRecovering()

    const { id } = send('after a failed start')

    await eventually(async () => expect((await submission(id))?.dispatchState).toBe('accepted'))
    expect(store.getRecord(SESSION)?.lease.handoffStage).toBeNull()
  })

  it('dispatches a send an idle-sweep close races, without deadlock', async () => {
    idleSweep = { intervalMs: 5, idleMs: 0 }
    const { first, release } = await heldAt('spawn')
    await first.sent
    await new Promise((resolve) => setTimeout(resolve, 30))
    release()

    await eventually(async () =>
      expect((await submission(first.id))?.dispatchState).toBe('accepted')
    )
    expect(delivered).toEqual([first.id])
  })
})
