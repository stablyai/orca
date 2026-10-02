// A chat whose lease bookkeeping failed while its agent ended, against the real host and the real
// chat journal database. The exit, the stop or the failed start was proven; only the write that
// would have recorded it failed. The next send must start the agent, and the renewer must land the
// missed write, because the host derives the lease from what it proved rather than what is stored.
//
// The database is made read-only with `query_only`, the journal database's own SQLITE_READONLY,
// which fails the record write and the journal write together as one unwritable store does.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import type { AgentSessionMutationEnvelope } from '../../../shared/agent-session-wire'
import type { AgentSessionOwnerProbe } from '../../../shared/agent-session-lease-adjudication'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import {
  findAgentSessionSpawnTokenProcesses,
  scanAgentSessionSpawnTokenProcesses
} from '../../runtime/agent-session-spawn-token-process-scan'
import { createStructuredAgentSessionOwnerProbe } from '../../runtime/structured-agent-session-owner-probe'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import { observeStructuredWorker } from '../../runtime/structured-worker-authority'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import type { StructuredAgentSessionEventSink } from './structured-agent-session-event-sink'
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
import { setStructuredAgentSessionHost } from './structured-agent-session-registry'

const CALLER = { callerKey: 'client-1' }
const EXITED_AT = NOW + 5_000

let root: string
let store: AgentSessionRecordStore
let host: StructuredAgentSessionHost
let acquire: Mock<StructuredAgentSessionAdapter['acquire']>
let releaseAcquisition: Mock<NonNullable<StructuredAgentSessionAdapter['releaseAcquisition']>>
/** Recovery's stop; never a real signal, since the rig's pids are invented. */
let stopOwnerProcess: Mock<(pid: number, signal: 'SIGTERM' | 'SIGKILL') => void>
let dispatch: Mock<StructuredAgentSessionAdapter['dispatch']>
let sink: StructuredAgentSessionEventSink | null
let logged: { message: string; scope: unknown }[]
/** What the host's owner probe answers; a dead pid by default, as after any of these endings. */
let probe: (record: AgentSessionRecord) => AgentSessionOwnerProbe | Promise<AgentSessionOwnerProbe>

function eventually(assertion: () => void | Promise<void>): Promise<void> {
  return vi.waitFor(assertion, { timeout: 10_000 })
}

function setStoreWritable(writable: boolean): void {
  openTestJournalHostDatabase(root).db.pragma(`query_only = ${writable ? 'OFF' : 'ON'}`)
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-stranded-lease-'))
  resetHostTestOperationIds()
  logged = []
  sink = null
  probe = (record) =>
    record.lease.ownerProcess ? { outcome: 'pid-absent' } : { outcome: 'reservation-unused' }
  let generation = 0
  releaseAcquisition = vi.fn(async () => true)
  stopOwnerProcess = vi.fn()
  acquire = vi.fn(async ({ fence, spawnToken, events }) => {
    sink = events ?? null
    return {
      process: { hostId: 'local', pid: 4242, processStartTimeMs: 1_700_000_000_000, spawnToken },
      acquisitionGeneration: `generation-${++generation}`,
      link: {
        linkId: `link-${fence}`,
        handle: { provider: 'codex' as const, threadId: THREAD },
        origin: store.getRecord(SESSION)?.providerHandleChain.length
          ? ('resumed' as const)
          : ('created' as const),
        mintedAtFence: fence,
        observedAt: NOW
      }
    }
  })
  dispatch = vi.fn(async () => ({
    state: 'accepted' as const,
    providerIdentity: {
      provider: 'codex' as const,
      threadId: THREAD,
      turnId: `turn-${dispatch.mock.calls.length}`,
      ordinal: dispatch.mock.calls.length
    }
  }))
  store = await openTestAgentSessionRecordStore(root)
  host = new StructuredAgentSessionHost({
    logger: {
      warn: (message, fields) => logged.push({ message, scope: fields.scope }),
      error: (message, fields) => logged.push({ message, scope: fields.scope })
    },
    store,
    adapter: {
      acquire,
      dispatch,
      closeSession: vi.fn(async () => true),
      releaseAcquisition,
      cancelTurn: vi.fn(async () => ({ cancelled: false })),
      answerPrompt: vi.fn(async () => undefined),
      setOption: vi.fn(async () => undefined)
    },
    journalDatabase: openTestJournalHostDatabase(root),
    claimKeyId: 'key-1',
    probeOwner: async (record) => probe(record),
    stopOwnerProcess: (pid, signal) => stopOwnerProcess(pid, signal),
    mintSpawnToken: () => `spawn-${acquire.mock.calls.length}`,
    now: () => NOW
  })
  setStructuredAgentSessionHost(host)
  expect(await host.attach(CALLER, hostTestAttachParams(null))).toMatchObject({ ok: true })
})

afterEach(async () => {
  setStoreWritable(true)
  setStructuredAgentSessionHost(null)
  await host.flushAllStreamedEvents()
  await rm(root, { recursive: true, force: true })
})

function sendParams(text: string) {
  const body = hostTestMessage(text)
  const envelope: AgentSessionMutationEnvelope = {
    sessionId: SESSION,
    clientOperationId: hostTestOperationId(),
    expectedRuntimeFence: store.getRecord(SESSION)?.lease.runtimeFence ?? 1,
    payloadFingerprint: computeAgentSessionPayloadFingerprint({
      method: 'agentSession.send',
      sessionId: SESSION,
      fields: { body }
    })
  }
  return { envelope, body }
}

/** The next send, which needs the agent this chat lost; resolves once it reached the provider. */
async function sendReachesTheAgent(text: string): Promise<void> {
  const params = sendParams(text)
  const dispatched = dispatch.mock.calls.length
  expect(await host.send(CALLER, params)).toMatchObject({ ok: true })
  await eventually(async () => {
    const snapshot = await host.journalSnapshot(SESSION)
    const errors = snapshot.items.flatMap((item) =>
      item.body.kind === 'status' && item.body.tone === 'error' ? [item.body.text] : []
    )
    const waiting = snapshot.submissions.flatMap((entry) =>
      entry.clientMessageId === params.envelope.clientOperationId ? [entry] : []
    )
    expect(
      dispatch.mock.calls.length,
      `error rows: ${JSON.stringify(errors)}; the send: ${JSON.stringify(waiting)}`
    ).toBe(dispatched + 1)
  })
}

function renewNow(): Promise<void> {
  const { runtimeState } = host.collaboratorsForTests()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the renewer is the runtime state's own private member; a tick is what this test drives.
  const internals = runtimeState as unknown as { leaseRenewer: { renewNow(): Promise<void> } }
  return internals.leaseRenewer.renewNow()
}

/** The provider exits while the store cannot take the release that records it. */
async function exitWhileStoreUnwritable(): Promise<number> {
  const fence = store.getRecord(SESSION)!.lease.runtimeFence
  setStoreWritable(false)
  await host.handleAdapterEvent({
    type: 'ended',
    sessionId: SESSION,
    reason: 'provider exited',
    cause: 'unexpected-exit',
    fence,
    acquisitionGeneration: 'generation-1',
    observedAt: EXITED_AT
  })
  expect(logged.map((entry) => entry.scope)).toContain('exit-owner-release')
  expect(store.getRecord(SESSION)?.lease).toMatchObject({
    claimStatus: 'live',
    runtimeFence: fence
  })
  setStoreWritable(true)
  return fence
}

describe('an exit whose release write failed', () => {
  it('lets the next send start the agent at the next fence', async () => {
    const fence = await exitWhileStoreUnwritable()

    await sendReachesTheAgent('after the exit')

    expect(acquire).toHaveBeenCalledTimes(2)
    expect(store.getRecord(SESSION)?.lease).toMatchObject({ claimStatus: 'live' })
    expect(store.getRecord(SESSION)!.lease.runtimeFence).toBeGreaterThan(fence)
  })

  it('reads as exited to every worker reader, never live', async () => {
    await exitWhileStoreUnwritable()

    expect(observeStructuredWorker({ sessionId: SESSION }).status).toBe('exited')
  })

  it('lands the missed release on the next renewal tick, with the exit as its evidence', async () => {
    const fence = await exitWhileStoreUnwritable()

    await renewNow()

    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      claimStatus: 'released',
      ownerProcess: null,
      runtimeFence: fence + 1,
      deathEvidence: { kind: 'exit-observed', observedAt: EXITED_AT, ownerFence: fence }
    })
  })

  it('keeps converging on later ticks while the store stays unwritable, reporting each failure', async () => {
    const fence = await exitWhileStoreUnwritable()
    setStoreWritable(false)
    await renewNow()
    expect(logged.map((entry) => entry.scope)).toContain('lease-convergence')
    expect(store.getRecord(SESSION)?.lease.claimStatus).toBe('live')

    setStoreWritable(true)
    await renewNow()

    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      claimStatus: 'released',
      runtimeFence: fence + 1
    })
  })

  it('starts the agent from one probe once the chat that watched the exit has closed', async () => {
    await exitWhileStoreUnwritable()
    await host.close(SESSION, 'evict')
    expect(host.hasSession(SESSION)).toBe(false)
    const probed = vi.fn(probe)
    probe = probed

    await sendReachesTheAgent('after closing and reopening')

    expect(acquire).toHaveBeenCalledTimes(2)
    // The start's eligibility and the acquisition decide on the same proof.
    expect(probed).toHaveBeenCalledOnce()
  })

  it('settles the turn the exit cut short as interrupted at the exit', async () => {
    sink?.appendItem(
      { provider: 'codex', threadId: THREAD, turnId: 'turn-0', ordinal: 0 },
      { kind: 'status', text: 'running', turnLifecycle: { turnId: 'turn-0', state: 'running' } },
      { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    await host.flushStreamedEvents(SESSION)
    await exitWhileStoreUnwritable()

    await sendReachesTheAgent('after the exit')

    const turn = (await host.journalSnapshot(SESSION)).items
      .map((item) => readAgentJournalTurn(item.body))
      .find((candidate) => candidate?.turnId === 'turn-0')
    expect(turn).toMatchObject({ state: 'interrupted', completedAt: EXITED_AT })
  })

  it('never frees a lease whose owner the host cannot prove gone', async () => {
    probe = () => ({ outcome: 'indeterminate', reason: 'no answer' })
    await exitWhileStoreUnwritable()
    await host.close(SESSION, 'evict')

    await renewNow()

    expect(store.getRecord(SESSION)?.lease.claimStatus).toBe('live')
    expect(observeStructuredWorker({ sessionId: SESSION }).status).toBe('unverifiable')
  })
})

describe('a failed start whose settlement write failed', () => {
  // The production probe with the macOS and Windows token scan, which can never prove a
  // reservation unused: only the host's memory of its own attempt can.
  const tokenScanCannotAnswer = createStructuredAgentSessionOwnerProbe(
    'local',
    async () => ({ outcome: 'pid-absent' }),
    (token) =>
      findAgentSessionSpawnTokenProcesses(token, () =>
        scanAgentSessionSpawnTokenProcesses('darwin')
      )
  )

  beforeEach(() => {
    probe = tokenScanCannotAnswer
  })

  async function failStartWithoutSettlement(): Promise<Mock> {
    await host.close(SESSION, 'evict')
    const settle = vi
      .spyOn(store, 'settleFailedAcquisition')
      .mockRejectedValueOnce(new Error('SQLITE_READONLY: attempt to write a readonly database'))
    expect(await host.send(CALLER, sendParams('the start fails'))).toMatchObject({ ok: true })
    await eventually(() => expect(settle).toHaveBeenCalledOnce())
    await eventually(async () => {
      const queued = (await host.journalSnapshot(SESSION)).submissions
      expect(queued.every((entry) => entry.dispatchState !== 'pending')).toBe(true)
    })
    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      claimStatus: 'reserved',
      handoffStage: 'new-owner-proving'
    })
    return settle
  }

  it('lets the next send start the agent though no scan can prove the reservation unused', async () => {
    acquire.mockRejectedValueOnce(new Error('provider failed to start'))
    await failStartWithoutSettlement()
    expect(store.getRecord(SESSION)?.lease.ownerProcess).toBeNull()

    await sendReachesTheAgent('after the failed start')

    expect(acquire).toHaveBeenCalledTimes(3)
    expect(store.getRecord(SESSION)?.lease.claimStatus).toBe('live')
  })

  it('replays the settlement the failed start could not write on the next renewal tick', async () => {
    acquire.mockRejectedValueOnce(new Error('provider failed to start'))
    const settle = await failStartWithoutSettlement()
    const fence = store.getRecord(SESSION)!.lease.runtimeFence

    await renewNow()

    expect(settle).toHaveBeenCalledTimes(2)
    expect(settle.mock.calls[1]).toEqual(settle.mock.calls[0])
    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      claimStatus: 'released',
      handoffStage: null,
      runtimeFence: fence + 1,
      deathEvidence: {
        kind: 'exit-observed',
        detail: 'acquisition cleanup proved no provider child remains',
        ownerFence: fence
      }
    })
    expect(observeStructuredWorker({ sessionId: SESSION }).status).toBe('exited')
  })

  /** Claude's shape on an unwritable store: no identity callback, so the identity commit after the
   *  spawn is the first write to fail; the release's close proves the child dead, then its handle
   *  write fails on the same store, so the cleanup reads unproven with no owner recorded. */
  async function failStartWhoseCleanupWriteFails(): Promise<Mock> {
    await host.close(SESSION, 'evict')
    const spawn = acquire.getMockImplementation()!
    acquire.mockImplementationOnce(async (input) => {
      const acquired = await spawn(input)
      setStoreWritable(false)
      return acquired
    })
    releaseAcquisition.mockImplementationOnce(async () => {
      await store.transitionHandoff(SESSION, (record) => ({
        ...record,
        updatedAt: record.updatedAt + 1
      }))
      return true
    })
    const settle = vi.spyOn(store, 'settleFailedAcquisition')
    expect(await host.send(CALLER, sendParams('the start fails'))).toMatchObject({ ok: true })
    await eventually(() => expect(settle).toHaveBeenCalledOnce())
    await eventually(() => expect(host.leaseState(SESSION)?.state).not.toBe('acquiring'))
    expect(settle.mock.calls[0]?.[0]).toMatchObject({ exitProof: 'unproven' })
    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      claimStatus: 'reserved',
      ownerProcess: null
    })
    setStoreWritable(true)
    return settle
  }

  it('lets the next send start after a Claude-shaped start whose cleanup reads unproven', async () => {
    await failStartWhoseCleanupWriteFails()
    // Free as its settlement would release it, but nothing claims the child exited.
    expect(host.leaseState(SESSION)?.state).toBe('free')
    expect(observeStructuredWorker({ sessionId: SESSION }).status).toBe('unverifiable')
    const dispatched = dispatch.mock.calls.length

    expect(await host.send(CALLER, sendParams('after the failed start'))).toMatchObject({
      ok: true
    })

    await eventually(() => expect(dispatch.mock.calls.length).toBeGreaterThan(dispatched))
    expect(acquire).toHaveBeenCalledTimes(3)
    expect(store.getRecord(SESSION)?.lease.claimStatus).toBe('live')
  })

  it('replays the Claude-shaped settlement once the store accepts writes', async () => {
    const settle = await failStartWhoseCleanupWriteFails()
    const fence = store.getRecord(SESSION)!.lease.runtimeFence

    await renewNow()

    expect(settle).toHaveBeenCalledTimes(2)
    expect(settle.mock.calls[1]).toEqual(settle.mock.calls[0])
    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      claimStatus: 'released',
      runtimeFence: fence + 1,
      deathEvidence: null
    })
  })

  /** A spawn whose identity was recorded and whose kill could not be proven: the settlement would
   *  park the owner in recovery rather than release it. */
  async function failStartLeavingAnUnprovenOwner(): Promise<void> {
    probe = () => ({ outcome: 'indeterminate', reason: 'no answer' })
    releaseAcquisition.mockResolvedValueOnce(false)
    const spawn = acquire.getMockImplementation()!
    acquire.mockImplementationOnce(async (input) => {
      const acquired = await spawn(input)
      await input.onSpawned?.(acquired.process)
      throw new Error('provider failed to start')
    })
    await failStartWithoutSettlement()
    expect(store.getRecord(SESSION)?.lease.ownerProcess).not.toBeNull()
  }

  it('reads an owner whose exit the failed start could not prove as recovering, never free', async () => {
    await failStartLeavingAnUnprovenOwner()
    expect(host.leaseState(SESSION)?.state).toBe('recovering')
    expect(observeStructuredWorker({ sessionId: SESSION }).status).toBe('unverifiable')

    await renewNow()

    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      claimStatus: 'reserved',
      handoffStage: 'recovering'
    })
  })

  it('never grants a client attach over that owner while its settlement still cannot land', async () => {
    await failStartLeavingAnUnprovenOwner()
    const before = store.getRecord(SESSION)!.lease
    probe = () => ({ outcome: 'identity-matched', matchedOn: ['spawn-token'] })
    vi.mocked(store.settleFailedAcquisition).mockRejectedValueOnce(
      new Error('SQLITE_BUSY: database is locked')
    )

    expect(await host.attach(CALLER, hostTestAttachParams(before.runtimeFence))).toMatchObject({
      ok: false
    })

    // No second child over an owner recovery never concluded about.
    expect(acquire).toHaveBeenCalledTimes(2)
    expect(store.getRecord(SESSION)?.lease).toBe(before)
  })

  it('lets recovery stop that owner first once its settlement lands', async () => {
    await failStartLeavingAnUnprovenOwner()
    const before = store.getRecord(SESSION)!.lease
    probe = () => ({ outcome: 'identity-matched', matchedOn: ['spawn-token'] })
    stopOwnerProcess.mockImplementation(() => {
      probe = () => ({ outcome: 'pid-absent' })
    })

    expect(await host.attach(CALLER, hostTestAttachParams(before.runtimeFence))).toMatchObject({
      ok: false,
      refusal: { code: 'agent_session_checkpoint_stale' }
    })

    expect(stopOwnerProcess).toHaveBeenCalledWith(4242, 'SIGTERM')
    expect(acquire).toHaveBeenCalledTimes(2)
    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      claimStatus: 'released',
      runtimeFence: before.runtimeFence + 1
    })
  })

  it('lands that settlement before the next send resolves recovery, as if it had been written', async () => {
    await failStartLeavingAnUnprovenOwner()

    // Recovery concludes as after the stored settlement: the owner cannot be verified, so it is
    // released without evidence and the send starts the agent.
    await sendReachesTheAgent('after recovery')

    expect(acquire).toHaveBeenCalledTimes(3)
    expect(store.getRecord(SESSION)?.lease.claimStatus).toBe('live')
  })
})

describe('a renewal tick racing a send that restarts the agent', () => {
  it('leaves the new fence alone and does not wait on the spawn', async () => {
    const fence = await exitWhileStoreUnwritable()
    await host.close(SESSION, 'evict')
    let releaseProbe: (answer: AgentSessionOwnerProbe) => void = () => {}
    probe = () =>
      new Promise((resolve) => {
        releaseProbe = resolve
        probe = () => ({ outcome: 'pid-absent' })
      })
    let releaseSpawn: () => void = () => {}
    const spawnHeld = new Promise<void>((resolve) => {
      releaseSpawn = resolve
    })
    const spawn = acquire.getMockImplementation()!
    acquire.mockImplementationOnce(async (input) => {
      await spawnHeld
      return spawn(input)
    })
    // The tick proves the stranded lease dead while a send reserves the next fence and spawns.
    let tickDone = false
    const tick = renewNow().then(() => {
      tickDone = true
    })
    expect(await host.send(CALLER, sendParams('during the tick'))).toMatchObject({ ok: true })
    await eventually(() => expect(acquire).toHaveBeenCalledTimes(2))
    releaseProbe({ outcome: 'pid-absent' })

    await eventually(() => expect(tickDone).toBe(true))
    releaseSpawn()
    await tick
    await eventually(() => expect(dispatch).toHaveBeenCalled())

    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      claimStatus: 'live',
      runtimeFence: fence + 1
    })
    expect(logged.map((entry) => entry.scope)).not.toContain('lease-convergence')
  })
})

describe('a stop whose release write keeps failing', () => {
  it('does not hold the next send once the stop proved the agent gone', async () => {
    const transition = vi
      .spyOn(store, 'transitionHandoff')
      .mockRejectedValue(new Error('SQLITE_READONLY: attempt to write a readonly database'))
    const { serialize, lifetime } = host.collaboratorsForTests()
    await expect(
      serialize(SESSION, () => lifetime.stopAgent(SESSION, { cause: 'host-stop' }))
    ).rejects.toThrow()

    await sendReachesTheAgent('after the stop')

    expect(acquire).toHaveBeenCalledTimes(2)
    transition.mockRestore()
  })
})

describe('the owner verdict clients see across a normal attach', () => {
  /** Samples the published verdict before and after every lease write, and at the spawn. */
  function sampleVerdicts(sessionId: string): string[] {
    const verdicts: string[] = []
    const sample = () => verdicts.push(observeStructuredWorker({ sessionId }).status)
    const reserve = store.reserveOwner.bind(store)
    vi.spyOn(store, 'reserveOwner').mockImplementation(async (request) => {
      sample()
      return reserve(request).finally(sample)
    })
    const commit = store.commitProcessIdentity.bind(store)
    vi.spyOn(store, 'commitProcessIdentity').mockImplementation(async (args) => {
      sample()
      return commit(args).finally(sample)
    })
    const prove = store.proveOwner.bind(store)
    vi.spyOn(store, 'proveOwner').mockImplementation(async (args) => {
      sample()
      return prove(args).finally(sample)
    })
    const spawn = acquire.getMockImplementation()!
    acquire.mockImplementation(async (input) => {
      sample()
      return spawn(input)
    })
    return verdicts
  }

  it('never reads unverifiable while a resume starts the agent', async () => {
    await host.close(SESSION, 'evict')
    const verdicts = sampleVerdicts(SESSION)

    await sendReachesTheAgent('wakes the chat')

    expect(verdicts.length).toBeGreaterThan(6)
    expect(verdicts).not.toContain('unverifiable')
    expect(observeStructuredWorker({ sessionId: SESSION }).status).toBe('live')
  })

  it('never reads unverifiable while a create starts the agent', async () => {
    const created = 'session-beta'
    acquire.mockImplementation(async ({ fence, spawnToken }) => ({
      process: { hostId: 'local', pid: 4343, processStartTimeMs: 1_700_000_000_000, spawnToken },
      acquisitionGeneration: 'generation-beta',
      link: {
        linkId: `link-beta-${fence}`,
        handle: { provider: 'codex' as const, threadId: 'thread-beta' },
        origin: 'created' as const,
        mintedAtFence: fence,
        observedAt: NOW
      }
    }))
    const verdicts = sampleVerdicts(created)

    expect(
      await host.attach(
        CALLER,
        hostTestAttachParams(null, {
          envelope: {
            sessionId: created,
            clientOperationId: hostTestOperationId(),
            expectedRuntimeFence: null,
            payloadFingerprint: ''
          },
          providerHandle: undefined
        })
      )
    ).toMatchObject({ ok: true })

    expect(verdicts.length).toBeGreaterThan(6)
    expect(verdicts).not.toContain('unverifiable')
    expect(observeStructuredWorker({ sessionId: created }).status).toBe('live')
  })
})
