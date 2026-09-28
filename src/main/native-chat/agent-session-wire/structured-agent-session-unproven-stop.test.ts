// The host ends its child as soon as it knows the child cannot take writes; the cleanup proof
// decides only the lease. Against the real host, store and journal: a stop that cannot prove the
// exit, and a start the child was seen to die in, each leave a chat the next send starts again.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { AgentSessionOwnerProbe } from '../../../shared/agent-session-lease-adjudication'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import { DISPATCH_REJECTED_CANCELLED } from '../../../shared/structured-agent-session-dispatch-rejection'
import { agentJournalTurnBody } from '../../../shared/agent-session-turn-record'
import { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import {
  AgentSessionAcquisitionRootExitObservedError,
  type StructuredAgentSessionAdapter
} from './structured-agent-session-adapter'
import {
  providerStartupFailureOutcome,
  unexpectedProviderExitOutcome
} from './structured-agent-session-dead-generation-settlement'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import { STRUCTURED_AGENT_SESSION_IDLE_MS } from './structured-agent-session-idle-sweep'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD,
  hostTestAttachParams,
  hostTestMessage,
  hostTestOperationId,
  resetHostTestOperationIds
} from './structured-agent-session-host-test-data'

const CALLER = { callerKey: 'client-1' }
const OWNER_PID = 4242
const ALIVE: AgentSessionOwnerProbe = {
  outcome: 'identity-matched',
  matchedOn: ['process-start-time']
}
const GONE: AgentSessionOwnerProbe = { outcome: 'pid-absent' }

let root: string
let store: AgentSessionRecordStore
let host: StructuredAgentSessionHost
let acquire: Mock<StructuredAgentSessionAdapter['acquire']>
let dispatch: Mock<StructuredAgentSessionAdapter['dispatch']>
let closeSession: Mock<NonNullable<StructuredAgentSessionAdapter['closeSession']>>
let adapterExtras: Partial<StructuredAgentSessionAdapter>
/** What the recorded owner's probe answers; recovery's stop flips it to gone. */
let ownerProbe: AgentSessionOwnerProbe
let stopOwnerProcess: Mock<(pid: number, signal: 'SIGTERM' | 'SIGKILL') => void>
/** Thrown by the next owner probe, once. */
let ownerProbeFailure: Error | null
let hostErrors: unknown[]
/** The host's clock; only the sweep tests move it. */
let clock: number

function eventually(assertion: () => void | Promise<void>): Promise<void> {
  return vi.waitFor(assertion, { timeout: 10_000 })
}

const spawnChild: StructuredAgentSessionAdapter['acquire'] = async ({ fence, spawnToken }) => ({
  process: { hostId: 'local', pid: OWNER_PID, processStartTimeMs: 1_700_000_000_000, spawnToken },
  acquisitionGeneration: `generation-${acquire.mock.calls.length}`,
  link: {
    linkId: `link-${fence}`,
    handle: { provider: 'codex' as const, threadId: THREAD },
    origin: store.getRecord(SESSION)?.providerHandleChain.length
      ? ('resumed' as const)
      : ('created' as const),
    mintedAtFence: fence,
    observedAt: NOW
  }
})

/** A Claude-shaped child: published at spawn, so it is `starting` until `started`. */
const spawnStartingChild: StructuredAgentSessionAdapter['acquire'] = async (input) => ({
  ...(await spawnChild(input)),
  providerChildPhase: 'starting' as const
})

function startHost(): void {
  host = new StructuredAgentSessionHost({
    store,
    adapter: {
      acquire,
      dispatch,
      closeSession,
      releaseAcquisition: vi.fn(async () => true),
      cancelTurn: vi.fn(async () => ({ cancelled: false })),
      answerPrompt: vi.fn(async () => undefined),
      setOption: vi.fn(async () => undefined),
      ...adapterExtras
    },
    journalRoot: root,
    claimKeyId: 'key-1',
    mintSpawnToken: () => `spawn-${acquire.mock.calls.length}`,
    probeOwner: async () => {
      const failure = ownerProbeFailure
      ownerProbeFailure = null
      if (failure) {
        throw failure
      }
      return ownerProbe
    },
    stopOwnerProcess,
    now: () => clock,
    onEventSinkError: ({ error }) => hostErrors.push(error)
  })
}

async function restartHost(): Promise<void> {
  await host.flushAllStreamedEvents()
  startHost()
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-unproven-stop-'))
  resetHostTestOperationIds()
  adapterExtras = {}
  hostErrors = []
  clock = NOW
  ownerProbe = GONE
  ownerProbeFailure = null
  stopOwnerProcess = vi.fn(() => {
    ownerProbe = GONE
  })
  acquire = vi.fn(spawnChild)
  closeSession = vi.fn(async () => true)
  dispatch = vi.fn(async (input) => ({
    state: 'accepted' as const,
    providerIdentity: {
      provider: 'codex' as const,
      threadId: THREAD,
      turnId: `turn-${input.clientMessageId}`,
      ordinal: dispatch.mock.calls.length
    }
  }))
  store = await AgentSessionRecordStore.open({ directory: join(root, 'store'), hostId: 'local' })
  startHost()
  expect(await host.attach(CALLER, hostTestAttachParams(null))).toMatchObject({ ok: true })
  await host.close(SESSION)
})

afterEach(async () => {
  await host.flushAllStreamedEvents()
  await rm(root, { recursive: true, force: true })
})

async function accept(text: string): Promise<string> {
  const body = hostTestMessage(text)
  const clientOperationId = hostTestOperationId()
  const sent = await host.send(CALLER, {
    envelope: {
      sessionId: SESSION,
      clientOperationId,
      expectedRuntimeFence: 1,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.send',
        sessionId: SESSION,
        fields: { body }
      })
    },
    body
  })
  expect(sent).toMatchObject({ ok: true, value: { submission: { dispatchState: 'pending' } } })
  return clientOperationId
}

function stop() {
  const turnId = 'turn-none'
  return host.cancel(CALLER, {
    envelope: {
      sessionId: SESSION,
      clientOperationId: hostTestOperationId(),
      expectedRuntimeFence: null,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.cancel',
        sessionId: SESSION,
        fields: { turnId }
      })
    },
    turnId
  })
}

async function submission(id: string): Promise<AgentJournalSubmission | undefined> {
  return (await host.journalSnapshot(SESSION)).submissions.find(
    (entry) => entry.clientMessageId === id
  )
}

function conversation() {
  return host['sessions'].get(SESSION)
}

function lease() {
  return store.getRecord(SESSION)?.lease
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

/** A ready child delivered one message, so the conversation holds it and its live lease. */
async function deliveredOnce(): Promise<void> {
  const first = await accept('first')
  await eventually(async () => expect((await submission(first))?.dispatchState).toBe('accepted'))
  expect(conversation()?.child).not.toBeNull()
  // The recorded owner is this child, alive until something stops it.
  ownerProbe = ALIVE
}

type HostActivity = { starts: number; sends: number }

function hostActivity(): HostActivity {
  return { starts: acquire.mock.calls.length, sends: dispatch.mock.calls.length }
}

const CONCLUDED = { claimStatus: 'released', handoffStage: null, ownerProcess: null } as const

/** Recovery concluded in the step that wrote it: the recorded owner was stopped by identity and the
 *  lease released, with no send and no new child since `before`. The next send starts plainly. */
async function expectRecoveryConcludedWithoutASend(before: HostActivity): Promise<void> {
  expect(stopOwnerProcess).toHaveBeenCalledWith(OWNER_PID, 'SIGTERM')
  expect(lease()).toMatchObject(CONCLUDED)
  expect(hostActivity()).toEqual(before)
  const next = await accept('next')
  await eventually(async () => expect((await submission(next))?.dispatchState).toBe('accepted'))
  expect(acquire).toHaveBeenCalledTimes(before.starts + 1)
  expect(stopOwnerProcess).toHaveBeenCalledTimes(1)
  expect(lease()).toMatchObject({ claimStatus: 'live', handoffStage: null })
}

/** Recovery could not verify the owner, so it released the lease without a signal, with no send and
 *  no new child since `before`; the next send starts plainly and signals nothing either. */
async function expectUnverifiedOwnerReleasedWithoutASignal(before: HostActivity): Promise<void> {
  expect(lease()).toMatchObject({ ...CONCLUDED, deathEvidence: null })
  expect(hostActivity()).toEqual(before)
  const next = await accept('next')
  await eventually(async () => expect((await submission(next))?.dispatchState).toBe('accepted'))
  expect(acquire).toHaveBeenCalledTimes(before.starts + 1)
  expect(stopOwnerProcess).not.toHaveBeenCalled()
}

describe('a stop that cannot prove its child exited (C′ trigger 1)', () => {
  it('at an idle eviction: the child ends, and its wind-down concludes the lease before any send (W40)', async () => {
    await deliveredOnce()
    closeSession.mockResolvedValueOnce(false)
    const before = hostActivity()

    await host.close(SESSION)

    expect(host.hasSession(SESSION)).toBe(false)
    await expectRecoveryConcludedWithoutASend(before)
  })

  it("at a user's Stop of a starting child: the conversation stays, and the lease concludes before any send (W40)", async () => {
    // The close ends the start the loop waits on, as the adapter's does, but proves no exit.
    const started = deferred<void>()
    adapterExtras = {
      awaitStarted: vi
        .fn<NonNullable<StructuredAgentSessionAdapter['awaitStarted']>>(async () => undefined)
        .mockImplementationOnce(() => started.promise)
    }
    await restartHost()
    acquire.mockImplementationOnce(spawnStartingChild)
    const first = await accept('first')
    await eventually(() => expect(conversation()?.child?.phase).toBe('starting'))
    ownerProbe = ALIVE
    closeSession.mockImplementationOnce(async () => {
      started.resolve()
      return false
    })
    const before = hostActivity()

    expect(await stop()).toMatchObject({ ok: true, value: { cancelled: true } })

    expect(conversation()?.child).toBeNull()
    expect(conversation()?.lastEndedChild).toMatchObject({ cause: 'user-stop', rootGone: false })
    expect(await submission(first)).toMatchObject({
      dispatchState: 'rejected',
      reason: DISPATCH_REJECTED_CANCELLED
    })
    await expectRecoveryConcludedWithoutASend(before)
  })

  it('after a journal sink failure: the force-closed child ends and its lease concludes before any send', async () => {
    const acknowledgeSessionRelease = vi.fn()
    adapterExtras = { acknowledgeSessionRelease }
    await restartHost()
    await deliveredOnce()
    const identity = { provider: 'codex' as const, threadId: THREAD, turnId: 'turn-q', ordinal: 9 }
    acquire.mock.calls.at(-1)?.[0].events?.appendItem(identity, {
      kind: 'question',
      question: 'Which target?',
      options: [{ id: 'web', label: 'Web' }],
      resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
    })
    await host.flushStreamedEvents(SESSION)
    const forceCloseSession = vi.fn(async () => false)
    host['deps'].adapter.forceCloseSession = forceCloseSession
    const before = hostActivity()

    host['eventRecovery'].recoverAfterSinkFailure(SESSION, new Error('disk full'))

    await eventually(() => expect(conversation()?.child).toBeNull())
    expect(forceCloseSession).toHaveBeenCalledWith(SESSION)
    expect(conversation()?.lastEndedChild).toMatchObject({
      cause: 'host-stop',
      reason: 'journal sink failure: disk full',
      rootGone: false
    })
    await eventually(() => expect(lease()).toMatchObject(CONCLUDED))
    // Settled like every other end: no card is left open with no agent behind it.
    const question = (await host.journalSnapshot(SESSION)).items.find(
      (item) => item.itemId === agentJournalItemKey(identity)
    )
    expect(question?.body).toMatchObject({ resolution: { state: 'cancelled' } })
    await eventually(() => expect(acknowledgeSessionRelease).toHaveBeenCalledWith(SESSION))
    await expectRecoveryConcludedWithoutASend(before)
  })

  it('leaves a stop that saw the root exit to the release it already takes (W41)', async () => {
    await deliveredOnce()
    closeSession.mockRejectedValueOnce(
      new AgentSessionAcquisitionRootExitObservedError(new Error('claude exited (code 1)'))
    )

    await host.close(SESSION)

    expect(lease()).toMatchObject({
      claimStatus: 'released',
      handoffStage: null,
      ownerProcess: null,
      deathEvidence: { kind: 'exit-observed' }
    })
    ownerProbe = GONE
    const next = await accept('next')
    await eventually(async () => expect((await submission(next))?.dispatchState).toBe('accepted'))
    expect(stopOwnerProcess).not.toHaveBeenCalled()
  })
})

describe('a start the child was seen to die in (C′ trigger 2)', () => {
  const EXIT = 'claude stream-json exited (code 1): claude: not signed in'
  const TEXT = providerStartupFailureOutcome(EXIT)

  /** The first child dies starting, before any exit is published for it. */
  async function diedStarting(reason = EXIT, whileStarting?: () => void): Promise<string> {
    const settled = deferred<{ reason: string }>()
    adapterExtras = { awaitStarted: vi.fn(() => settled.promise) }
    await restartHost()
    acquire.mockImplementationOnce(spawnStartingChild)
    const first = await accept('first')
    await eventually(() => expect(adapterExtras.awaitStarted).toHaveBeenCalled())
    whileStarting?.()
    ownerProbe = ALIVE
    settled.resolve({ reason })
    return first
  }

  it('keeps a long start failure within what the record store accepts, so the release sticks', async () => {
    const stderr = Array.from({ length: 40 }, (_, line) => `stderr line ${line}`).join('\n')
    const exit = `claude exited (code 1): ${stderr}`
    await diedStarting(exit)

    await eventually(() => expect(lease()).toMatchObject({ claimStatus: 'released' }))
    expect(lease()?.deathEvidence?.detail).toBe(exit.slice(0, 512))
    // Read back from disk: a detail past the store's bound is quarantined and the release undone.
    const reopened = await AgentSessionRecordStore.open({
      directory: join(root, 'store'),
      hostId: 'local'
    })
    expect(reopened.getRecord(SESSION)?.lease).toMatchObject({
      claimStatus: 'released',
      ownerProcess: null,
      deathEvidence: { kind: 'exit-observed' }
    })
    // And the live store's next transaction keeps it: the Retry starts on the released lease.
    ownerProbe = GONE
    const retry = await accept('retry')
    await eventually(async () => expect((await submission(retry))?.dispatchState).toBe('accepted'))
  })

  it('ends the child when the death is seen, so a Retry at once starts a new child (W42)', async () => {
    const first = await diedStarting()

    await eventually(async () => expect((await submission(first))?.dispatchState).toBe('rejected'))
    await eventually(() => expect(conversation()?.child).toBeNull())
    // The provider's own words, not the chat's copy of them.
    expect(conversation()?.lastEndedChild).toMatchObject({
      cause: 'exit',
      reason: EXIT,
      duringStartup: true,
      rootGone: true
    })
    // The child ends at the stop step; the lease moves at the end of the same wind-down.
    await eventually(() =>
      expect(lease()).toMatchObject({
        claimStatus: 'released',
        handoffStage: null,
        deathEvidence: { detail: EXIT }
      })
    )

    ownerProbe = GONE
    const retry = await accept('retry')
    await eventually(async () => expect((await submission(retry))?.dispatchState).toBe('accepted'))
    // One rejection with the start's words, the first message's; the Retry got a new child.
    const rejected = (await host.journalSnapshot(SESSION)).submissions
      .filter((entry) => entry.reason === TEXT)
      .map((entry) => entry.clientMessageId)
    expect(rejected).toEqual([first])
    expect(acquire).toHaveBeenCalledTimes(3)
  })

  // The provider's own exit event never comes here, so the stop is the only release.
  it('tells a reader open throughout the fence its release moved the lease to', async () => {
    const fences: number[] = []
    let startedAt = 0
    await diedStarting(EXIT, () => {
      startedAt = lease()?.runtimeFence ?? 0
      host.subscribe({
        id: 'pane',
        sessionId: SESSION,
        emit: (event) => {
          if (event.type !== 'end' && event.fence !== undefined) {
            fences.push(event.fence)
          }
        }
      })
    })

    await eventually(() => expect(fences.at(-1)).toBe(startedAt + 1))
    expect(lease()).toMatchObject({ claimStatus: 'released', runtimeFence: startedAt + 1 })
  })

  it('concludes the lease before any send when that close is unproven (W43)', async () => {
    closeSession.mockResolvedValueOnce(false)
    let before = hostActivity()
    const first = await diedStarting(EXIT, () => {
      before = hostActivity()
    })

    await eventually(() => expect(conversation()?.child).toBeNull())
    expect(await submission(first)).toMatchObject({ dispatchState: 'rejected', reason: TEXT })
    expect(conversation()?.lastEndedChild).toMatchObject({ cause: 'exit', rootGone: false })
    await eventually(() => expect(lease()).toMatchObject(CONCLUDED))
    await expectRecoveryConcludedWithoutASend(before)
  })

  it('tells a reader open throughout the fence that concluding its recovery moved the lease to', async () => {
    closeSession.mockResolvedValueOnce(false)
    const fences: number[] = []
    let startedAt = 0
    await diedStarting(EXIT, () => {
      startedAt = lease()?.runtimeFence ?? 0
      host.subscribe({
        id: 'pane',
        sessionId: SESSION,
        emit: (event) => {
          if (event.type !== 'end' && event.fence !== undefined) {
            fences.push(event.fence)
          }
        }
      })
    })

    await eventually(() => expect(fences.at(-1)).toBe(startedAt + 1))
    expect(lease()).toMatchObject({ ...CONCLUDED, runtimeFence: startedAt + 1 })
  })
})

describe('a re-attach that fails after it bound the live child', () => {
  it('ends that child through the same settlement as every other end, so its question closes', async () => {
    const params = hostTestAttachParams(lease()?.runtimeFence ?? null)
    expect(await host.attach(CALLER, params)).toMatchObject({ ok: true })
    const identity = { provider: 'codex' as const, threadId: THREAD, turnId: 'turn-q', ordinal: 9 }
    acquire.mock.calls.at(-1)?.[0].events?.appendItem(identity, {
      kind: 'question',
      question: 'Which target?',
      options: [{ id: 'web', label: 'Web' }],
      resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
    })
    await host.flushStreamedEvents(SESSION)
    const question = async () =>
      (await host.journalSnapshot(SESSION)).items.find(
        (item) => item.itemId === agentJournalItemKey(identity)
      )
    expect((await question())?.body).toMatchObject({ resolution: { state: 'pending' } })
    // The same attach again reuses the live child, then fails before it commits; its cleanup
    // releases that child.
    vi.spyOn(store, 'recordOperationOutcome').mockRejectedValueOnce(new Error('disk full'))

    // It fails, however its replayed operation's own settlement then answers.
    await host.attach(CALLER, params).catch(() => undefined)

    expect(acquire).toHaveBeenCalledTimes(2)
    expect(conversation()?.lastEndedChild).toMatchObject({ cause: 'attach-failed' })
    expect((await question())?.body).toMatchObject({ resolution: { state: 'cancelled' } })
  })
})

describe('an attach that fails after acquiring and cannot prove its child gone (C′ trigger 3)', () => {
  /** A re-attach starts a child, then fails before it commits; the cleanup proves no exit. */
  async function failedAttachWithUnprovenExit(duringCleanup?: () => void): Promise<void> {
    const releaseAcquisition = vi.fn(async () => {
      // The recorded owner is the child this attach started, alive until recovery stops it.
      ownerProbe = ALIVE
      duringCleanup?.()
      return false
    })
    host['deps'].adapter.releaseAcquisition = releaseAcquisition
    vi.spyOn(store, 'recordOperationOutcome').mockRejectedValueOnce(new Error('disk full'))

    await expect(
      host.attach(CALLER, hostTestAttachParams(lease()?.runtimeFence ?? null))
    ).rejects.toBeDefined()

    expect(releaseAcquisition).toHaveBeenCalledWith({ sessionId: SESSION })
  }

  it('concludes the lease in the same step, with no send and no new child', async () => {
    const before = hostActivity()

    await failedAttachWithUnprovenExit()

    await expectRecoveryConcludedWithoutASend({ ...before, starts: before.starts + 1 })
  })

  it('releases an owner whose probe throws, unsignalled, and reports it; the attach keeps its own failure', async () => {
    const crash = new Error('owner probe crashed')
    const before = hostActivity()

    await failedAttachWithUnprovenExit(() => {
      ownerProbeFailure = crash
    })

    expect(hostErrors).toContain(crash)
    await expectUnverifiedOwnerReleasedWithoutASignal({ ...before, starts: before.starts + 1 })
  })
})

describe("a stop's recovery whose owner probe cannot answer", () => {
  it('releases an owner it cannot verify, and signals nothing', async () => {
    await deliveredOnce()
    ownerProbe = { outcome: 'indeterminate', reason: 'the process table could not be read' }
    closeSession.mockResolvedValueOnce(false)
    const before = hostActivity()

    await host.close(SESSION)

    expect(lease()).toMatchObject({ ...CONCLUDED, deathEvidence: null })
    expect(stopOwnerProcess).not.toHaveBeenCalled()
    expect(hostActivity()).toEqual(before)
  })

  it('reads a probe that throws as an owner it cannot verify: released unsignalled, and reported', async () => {
    await deliveredOnce()
    closeSession.mockResolvedValueOnce(false)
    const crash = new Error('owner probe crashed')
    ownerProbeFailure = crash
    const before = hostActivity()

    await host.close(SESSION)

    expect(host.hasSession(SESSION)).toBe(false)
    expect(hostErrors).toContain(crash)
    await expectUnverifiedOwnerReleasedWithoutASignal(before)
  })
})

const OPEN_TURN = { provider: 'codex' as const, threadId: THREAD, turnId: 'turn-r', ordinal: 20 }
const OPEN_QUESTION = {
  provider: 'codex' as const,
  threadId: THREAD,
  turnId: 'turn-r',
  ordinal: 21
}

async function item(identity: typeof OPEN_TURN) {
  return (await host.journalSnapshot(SESSION)).items.find(
    (entry) => entry.itemId === agentJournalItemKey(identity)
  )
}

/** The live child took a send it has not answered, and left a turn and a question open. */
async function childLeftWorkOpen(start: () => Promise<void> = deliveredOnce): Promise<string> {
  await start()
  dispatch.mockResolvedValueOnce({ state: 'admitted' })
  const handed = await accept('handed')
  await eventually(async () => expect((await submission(handed))?.handedOverAt).toBeDefined())
  const events = acquire.mock.calls.at(-1)?.[0].events
  events?.appendItem(
    OPEN_TURN,
    agentJournalTurnBody({ turnId: 'turn-r', state: 'running', startedAt: NOW })
  )
  events?.appendItem(OPEN_QUESTION, {
    kind: 'question',
    question: 'Which target?',
    options: [{ id: 'web', label: 'Web' }],
    resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
  })
  await host.flushStreamedEvents(SESSION)
  expect((await submission(handed))?.dispatchState).toBe('pending')
  return handed
}

describe('a new child never inherits a wait on the one before it', () => {
  it('re-derives what an ended child left unsettled, in the conversation that stayed open', async () => {
    const handed = await childLeftWorkOpen()
    const journal = conversation()?.journal
    if (!journal) {
      throw new Error('conversation not open')
    }
    // The ended child's own settlement never lands; its lease moves all the same.
    vi.spyOn(journal, 'markPendingSubmissionsUnknown').mockRejectedValueOnce(new Error('disk full'))
    host['deps'].adapter.forceCloseSession = vi.fn(async () => false)

    const before = hostActivity()

    host['eventRecovery'].recoverAfterSinkFailure(SESSION, new Error('disk full'))

    await eventually(() => expect(lease()).toMatchObject(CONCLUDED))
    expect((await submission(handed))?.dispatchState).toBe('pending')
    expect((await item(OPEN_QUESTION))?.body).toMatchObject({ resolution: { state: 'pending' } })
    await expectRecoveryConcludedWithoutASend(before)
    expect(await submission(handed)).toMatchObject({ dispatchState: 'unknown', recovered: true })
    expect((await item(OPEN_TURN))?.body).toMatchObject({ state: 'unverifiable' })
    expect((await item(OPEN_QUESTION))?.body).toMatchObject({ resolution: { state: 'cancelled' } })
  })

  it('leaves a live child its own unanswered send when its attach is retried', async () => {
    const params = hostTestAttachParams(lease()?.runtimeFence ?? null)
    const handed = await childLeftWorkOpen(async () => {
      expect(await host.attach(CALLER, params)).toMatchObject({ ok: true })
    })

    // The retry replays onto the child it started; no new one is acquired.
    expect(await host.attach(CALLER, params)).toMatchObject({ ok: true })

    expect(acquire).toHaveBeenCalledTimes(2)
    expect((await submission(handed))?.dispatchState).toBe('pending')
  })
})

describe('bookkeeping that fails after the child ended', () => {
  it('never keeps an unproven stop from concluding its lease', async () => {
    const acknowledgeSessionRelease = vi.fn()
    adapterExtras = { acknowledgeSessionRelease }
    await restartHost()
    const handed = await childLeftWorkOpen()
    const journal = conversation()?.journal
    if (!journal) {
      throw new Error('conversation not open')
    }
    vi.spyOn(journal, 'markPendingSubmissionsUnknown').mockRejectedValueOnce(new Error('disk full'))
    closeSession.mockResolvedValueOnce(false)
    const before = hostActivity()

    await host.close(SESSION)

    expect(hostErrors).toContainEqual(expect.objectContaining({ step: 'settle-dead-generation' }))
    // The handle stays open: the send still reads pending, so it is more than a cache.
    expect(host.hasSession(SESSION)).toBe(true)
    expect(acknowledgeSessionRelease).toHaveBeenCalledWith(SESSION)
    await expectRecoveryConcludedWithoutASend(before)
    expect(await submission(handed)).toMatchObject({ dispatchState: 'unknown', recovered: true })
  })

  it('retries a settlement that could not be written on each sweep, then lets the handle go, with no send', async () => {
    const handed = await childLeftWorkOpen()
    const journal = conversation()?.journal
    if (!journal) {
      throw new Error('conversation not open')
    }
    // The stop's own settlement and the first sweep's retry fail; the second retry lands.
    vi.spyOn(journal, 'markPendingSubmissionsUnknown')
      .mockRejectedValueOnce(new Error('disk full'))
      .mockRejectedValueOnce(new Error('disk full'))
    await host.close(SESSION)
    expect(hostErrors).toContainEqual(expect.objectContaining({ step: 'settle-dead-generation' }))
    expect(lease()).toMatchObject(CONCLUDED)
    const before = hostActivity()
    const sweep = () => {
      clock += STRUCTURED_AGENT_SESSION_IDLE_MS + 1
      return host['lifetime'].idleSweep.tick()
    }

    await sweep()
    // Read from the handle that stayed open, not a reopen that would re-derive it on its own.
    expect(host.hasSession(SESSION)).toBe(true)
    expect((await submission(handed))?.dispatchState).toBe('pending')

    await sweep()
    expect(host.hasSession(SESSION)).toBe(true)
    expect(await submission(handed)).toMatchObject({ dispatchState: 'unknown' })

    // Nothing pins the handle now; the reopen settles the turn and the card the child left.
    await sweep()
    expect(host.hasSession(SESSION)).toBe(false)
    expect((await item(OPEN_TURN))?.body).toMatchObject({ state: 'interrupted' })
    expect((await item(OPEN_QUESTION))?.body).toMatchObject({ resolution: { state: 'cancelled' } })
    expect(hostActivity()).toEqual(before)
  })

  it('lets the handle go once a send an exited child left is marked, and the reopen tells the exit', async () => {
    const handed = await childLeftWorkOpen()
    const open = conversation()
    const child = open?.child
    if (!open || !child?.generation) {
      throw new Error('no live child')
    }
    const acquired = acquire.mock.calls.length
    // The exit's own settlement never lands.
    vi.spyOn(open.journal, 'markPendingSubmissionsUnknown').mockRejectedValueOnce(
      new Error('disk full')
    )
    await host.handleAdapterEvent({
      type: 'ended',
      sessionId: SESSION,
      reason: 'killed',
      cause: 'unexpected-exit',
      fence: child.fence,
      acquisitionGeneration: child.generation
    })
    await eventually(() => expect(conversation()?.child).toBeNull())
    expect((await submission(handed))?.dispatchState).toBe('pending')
    expect((await item(OPEN_TURN))?.body).toMatchObject({ state: 'running' })
    const sweep = () => {
      clock += STRUCTURED_AGENT_SESSION_IDLE_MS + 1
      return host['lifetime'].idleSweep.tick()
    }

    await sweep()
    expect(host.hasSession(SESSION)).toBe(true)
    expect(await submission(handed)).toMatchObject({ dispatchState: 'unknown' })

    await sweep()
    expect(host.hasSession(SESSION)).toBe(false)
    const reopened = (await host.journalSnapshot(SESSION)).items
    expect((await item(OPEN_TURN))?.body).toMatchObject({ state: 'interrupted', completedAt: NOW })
    expect((await item(OPEN_QUESTION))?.body).toMatchObject({ resolution: { state: 'cancelled' } })
    expect(
      reopened.flatMap((entry) => (entry.body.kind === 'status' ? [entry.body.text] : []))
    ).toContain(unexpectedProviderExitOutcome('killed'))
    // No send and no relaunch did any of it.
    expect(acquire).toHaveBeenCalledTimes(acquired)
  })

  it('publishes the ended child even when the release after it cannot be written', async () => {
    await deliveredOnce()
    const publishStatus = vi.spyOn(host['clientDelivery'], 'publishStatus')
    closeSession.mockResolvedValueOnce(false)
    vi.spyOn(store, 'transitionHandoff').mockRejectedValueOnce(new Error('store write lost'))

    await expect(host.close(SESSION)).rejects.toMatchObject({ step: 'release-lease' })

    expect(conversation()?.child).toBeNull()
    expect(publishStatus).toHaveBeenCalledWith(SESSION)
    // The retry repeats only what is still owed: no second close, and the lease moves.
    await host.close(SESSION)
    expect(closeSession).toHaveBeenCalledTimes(2)
    expect(lease()).toMatchObject(CONCLUDED)
  })

  it("retries a sink failure's release that could not be written at the next close", async () => {
    const acknowledgeSessionRelease = vi.fn()
    adapterExtras = { acknowledgeSessionRelease }
    await restartHost()
    await deliveredOnce()
    host['deps'].adapter.forceCloseSession = vi.fn(async () => false)
    vi.spyOn(store, 'transitionHandoff').mockRejectedValueOnce(new Error('store write lost'))

    host['eventRecovery'].recoverAfterSinkFailure(SESSION, new Error('disk full'))

    await eventually(() =>
      expect(hostErrors).toContainEqual(expect.objectContaining({ step: 'release-lease' }))
    )
    expect(conversation()?.child).toBeNull()
    expect(lease()).toMatchObject({ claimStatus: 'live', handoffStage: null })
    expect(acknowledgeSessionRelease).not.toHaveBeenCalled()

    await host.close(SESSION)

    expect(lease()).toMatchObject(CONCLUDED)
    expect(acknowledgeSessionRelease).toHaveBeenCalledWith(SESSION)
    // The child was already force-closed; the retry only finishes its wind-down.
    expect(closeSession).toHaveBeenCalledTimes(1)
  })
})
