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
import { providerStartupFailureOutcome } from './structured-agent-session-dead-generation-settlement'
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
let hostErrors: unknown[]

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
    probeOwner: async () => ownerProbe,
    stopOwnerProcess,
    releaseGraceMs: 60_000,
    now: () => NOW,
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
  ownerProbe = GONE
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

function submission(id: string): AgentJournalSubmission | undefined {
  return host.journalSnapshot(SESSION).submissions.find((entry) => entry.clientMessageId === id)
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
  await eventually(() => expect(submission(first)?.dispatchState).toBe('accepted'))
  expect(conversation()?.child).not.toBeNull()
  // The recorded owner is this child, alive until something stops it.
  ownerProbe = ALIVE
}

/** The next send starts only after recovery stopped the recorded owner by identity. */
async function expectNextSendStartsAfterRecovery(): Promise<void> {
  const starts = acquire.mock.calls.length
  const next = await accept('next')
  await eventually(() => expect(submission(next)?.dispatchState).toBe('accepted'))
  expect(stopOwnerProcess).toHaveBeenCalledWith(OWNER_PID, 'SIGTERM')
  expect(acquire).toHaveBeenCalledTimes(starts + 1)
  expect(lease()).toMatchObject({ claimStatus: 'live', handoffStage: null })
}

describe('a stop that cannot prove its child exited (C′ trigger 1)', () => {
  it('at an idle eviction: the child ends, the lease goes to recovery, and the next send starts (W40)', async () => {
    await deliveredOnce()
    closeSession.mockResolvedValueOnce(false)

    await host.close(SESSION)

    expect(host.hasSession(SESSION)).toBe(false)
    expect(lease()).toMatchObject({
      claimStatus: 'live',
      handoffStage: 'recovering',
      ownerProcess: { pid: OWNER_PID }
    })
    await expectNextSendStartsAfterRecovery()
  })

  it("at a user's Stop of a starting child: the conversation stays, and the next send starts (W40)", async () => {
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

    expect(await stop()).toMatchObject({ ok: true, value: { cancelled: true } })

    expect(conversation()?.child).toBeNull()
    expect(conversation()?.lastEndedChild).toMatchObject({ cause: 'user-stop', rootGone: false })
    expect(submission(first)).toMatchObject({
      dispatchState: 'rejected',
      reason: DISPATCH_REJECTED_CANCELLED
    })
    expect(lease()).toMatchObject({ claimStatus: 'live', handoffStage: 'recovering' })
    await expectNextSendStartsAfterRecovery()
  })

  it('after a journal sink failure: the force-closed child ends and its lease goes to recovery', async () => {
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

    host['eventRecovery'].recoverAfterSinkFailure(SESSION, new Error('disk full'))

    await eventually(() => expect(conversation()?.child).toBeNull())
    expect(forceCloseSession).toHaveBeenCalledWith(SESSION)
    expect(conversation()?.lastEndedChild).toMatchObject({
      cause: 'host-stop',
      reason: 'journal sink failure: disk full',
      rootGone: false
    })
    await eventually(() => expect(lease()).toMatchObject({ handoffStage: 'recovering' }))
    // Settled like every other end: no card is left open with no agent behind it.
    const question = host
      .journalSnapshot(SESSION)
      .items.find((item) => item.itemId === agentJournalItemKey(identity))
    expect(question?.body).toMatchObject({ resolution: { state: 'cancelled' } })
    await eventually(() => expect(acknowledgeSessionRelease).toHaveBeenCalledWith(SESSION))
    await expectNextSendStartsAfterRecovery()
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
    await eventually(() => expect(submission(next)?.dispatchState).toBe('accepted'))
    expect(stopOwnerProcess).not.toHaveBeenCalled()
  })
})

describe('a start the child was seen to die in (C′ trigger 2)', () => {
  const EXIT = 'claude stream-json exited (code 1): claude: not signed in'
  const TEXT = providerStartupFailureOutcome(EXIT)

  /** The first child dies starting, before any exit is published for it. */
  async function diedStarting(reason = EXIT): Promise<string> {
    const settled = deferred<{ reason: string }>()
    adapterExtras = { awaitStarted: vi.fn(() => settled.promise) }
    await restartHost()
    acquire.mockImplementationOnce(spawnStartingChild)
    const first = await accept('first')
    await eventually(() => expect(adapterExtras.awaitStarted).toHaveBeenCalled())
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
    await eventually(() => expect(submission(retry)?.dispatchState).toBe('accepted'))
  })

  it('ends the child when the death is seen, so a Retry at once starts a new child (W42)', async () => {
    const first = await diedStarting()

    await eventually(() => expect(submission(first)?.dispatchState).toBe('rejected'))
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
    await eventually(() => expect(submission(retry)?.dispatchState).toBe('accepted'))
    // One rejection with the start's words, the first message's; the Retry got a new child.
    const rejected = host
      .journalSnapshot(SESSION)
      .submissions.filter((entry) => entry.reason === TEXT)
      .map((entry) => entry.clientMessageId)
    expect(rejected).toEqual([first])
    expect(acquire).toHaveBeenCalledTimes(3)
  })

  it('hands the lease to recovery when that close is unproven, and the next send starts (W43)', async () => {
    closeSession.mockResolvedValueOnce(false)
    const first = await diedStarting()

    await eventually(() => expect(conversation()?.child).toBeNull())
    expect(submission(first)).toMatchObject({ dispatchState: 'rejected', reason: TEXT })
    expect(conversation()?.lastEndedChild).toMatchObject({ cause: 'exit', rootGone: false })
    await eventually(() =>
      expect(lease()).toMatchObject({ claimStatus: 'live', handoffStage: 'recovering' })
    )
    await expectNextSendStartsAfterRecovery()
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
    const question = () =>
      host
        .journalSnapshot(SESSION)
        .items.find((item) => item.itemId === agentJournalItemKey(identity))
    expect(question()?.body).toMatchObject({ resolution: { state: 'pending' } })
    // The same attach again reuses the live child, then fails before it commits; its cleanup
    // releases that child.
    vi.spyOn(store, 'recordOperationOutcome').mockRejectedValueOnce(new Error('disk full'))

    // It fails, however its replayed operation's own settlement then answers.
    await host.attach(CALLER, params).catch(() => undefined)

    expect(acquire).toHaveBeenCalledTimes(2)
    expect(conversation()?.lastEndedChild).toMatchObject({ cause: 'attach-failed' })
    expect(question()?.body).toMatchObject({ resolution: { state: 'cancelled' } })
  })
})

const OPEN_TURN = { provider: 'codex' as const, threadId: THREAD, turnId: 'turn-r', ordinal: 20 }
const OPEN_QUESTION = {
  provider: 'codex' as const,
  threadId: THREAD,
  turnId: 'turn-r',
  ordinal: 21
}

function item(identity: typeof OPEN_TURN) {
  return host
    .journalSnapshot(SESSION)
    .items.find((entry) => entry.itemId === agentJournalItemKey(identity))
}

/** The live child took a send it has not answered, and left a turn and a question open. */
async function childLeftWorkOpen(start: () => Promise<void> = deliveredOnce): Promise<string> {
  await start()
  dispatch.mockResolvedValueOnce({ state: 'admitted' })
  const handed = await accept('handed')
  await eventually(() => expect(submission(handed)?.handedOverAt).toBeDefined())
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
  expect(submission(handed)?.dispatchState).toBe('pending')
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

    host['eventRecovery'].recoverAfterSinkFailure(SESSION, new Error('disk full'))

    await eventually(() => expect(lease()).toMatchObject({ handoffStage: 'recovering' }))
    expect(submission(handed)?.dispatchState).toBe('pending')
    expect(item(OPEN_QUESTION)?.body).toMatchObject({ resolution: { state: 'pending' } })
    await expectNextSendStartsAfterRecovery()
    expect(submission(handed)).toMatchObject({ dispatchState: 'unknown', recovered: true })
    expect(item(OPEN_TURN)?.body).toMatchObject({ state: 'unverifiable' })
    expect(item(OPEN_QUESTION)?.body).toMatchObject({ resolution: { state: 'cancelled' } })
  })

  it('leaves a live child its own unanswered send when its attach is retried', async () => {
    const params = hostTestAttachParams(lease()?.runtimeFence ?? null)
    const handed = await childLeftWorkOpen(async () => {
      expect(await host.attach(CALLER, params)).toMatchObject({ ok: true })
    })

    // The retry replays onto the child it started; no new one is acquired.
    expect(await host.attach(CALLER, params)).toMatchObject({ ok: true })

    expect(acquire).toHaveBeenCalledTimes(2)
    expect(submission(handed)?.dispatchState).toBe('pending')
  })
})

describe('bookkeeping that fails after the child ended', () => {
  it('never keeps an unproven stop from handing the lease to recovery', async () => {
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

    await host.close(SESSION)

    expect(hostErrors).toContainEqual(expect.objectContaining({ step: 'settle-dead-generation' }))
    expect(host.hasSession(SESSION)).toBe(false)
    expect(acknowledgeSessionRelease).toHaveBeenCalledWith(SESSION)
    expect(lease()).toMatchObject({
      claimStatus: 'live',
      handoffStage: 'recovering',
      ownerProcess: { pid: OWNER_PID }
    })
    await expectNextSendStartsAfterRecovery()
    expect(submission(handed)).toMatchObject({ dispatchState: 'unknown', recovered: true })
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
    expect(lease()).toMatchObject({ claimStatus: 'live', handoffStage: 'recovering' })
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

    expect(lease()).toMatchObject({ claimStatus: 'live', handoffStage: 'recovering' })
    expect(acknowledgeSessionRelease).toHaveBeenCalledWith(SESSION)
    // The child was already force-closed; the retry only finishes its wind-down.
    expect(closeSession).toHaveBeenCalledTimes(1)
  })
})
