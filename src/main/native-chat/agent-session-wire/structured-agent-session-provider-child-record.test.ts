import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
// The provider child is its own record on the conversation: stopping it, losing it or failing to
// start it ends the child, never the conversation. Against the real host, store and journal, with a
// live subscriber opened before each action.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import type {
  AgentSessionStatusSummary,
  AgentSessionSubscribeEvent
} from '../../../shared/agent-session-wire'
import { DISPATCH_REJECTED_CANCELLED } from '../../../shared/structured-agent-session-dispatch-rejection'
import {
  agentSessionFailureFact,
  type AgentSessionFailureFact,
  type SubmissionRejectionFact
} from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import { openAgentSessionJournal } from '../agent-session-journal/journal-store-factory'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import { ensureStructuredAgentSessionAgent } from './structured-agent-session-agent-start'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import { stopStructuredAgentSessionAgentUnderSerialize } from './structured-agent-session-host-lifetime'
import { structuredAgentSessionConversationFence } from './structured-agent-session-provider-child'
import {
  HOST_TEST_LOCATION,
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD,
  hostTestAttachParams,
  hostTestMessage,
  hostTestOperationId,
  resetHostTestOperationIds
} from './structured-agent-session-host-test-data'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import { createStructuredAgentSessionLogger } from './structured-agent-session-logger'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'

const CALLER = { callerKey: 'client-1' }
const CHAT_CLOSED = agentSessionFailureWords(agentSessionFailureFact('chatClosed'), {
  surface: 'rejection'
})

let root: string
let store: AgentSessionRecordStore
let host: StructuredAgentSessionHost
let acquire: Mock<StructuredAgentSessionAdapter['acquire']>
let dispatch: Mock<StructuredAgentSessionAdapter['dispatch']>
let adapterExtras: Partial<StructuredAgentSessionAdapter>

function eventually(assertion: () => void | Promise<void>): Promise<void> {
  return vi.waitFor(assertion, { timeout: 10_000 })
}

function generation(): string {
  return `generation-${acquire.mock.calls.length}`
}

const spawnChild: StructuredAgentSessionAdapter['acquire'] = async ({ fence, spawnToken }) => ({
  process: { hostId: 'local', pid: 4242, processStartTimeMs: 1_700_000_000_000, spawnToken },
  acquisitionGeneration: generation(),
  link: {
    linkId: `link-${fence}`,
    handle: codexProviderHandle(THREAD),
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
    logger: createStructuredAgentSessionLogger(),
    store,
    adapter: {
      acquire,
      dispatch,
      closeSession: vi.fn(async () => true),
      releaseAcquisition: vi.fn(async () => true),
      cancelTurn: vi.fn(async () => ({ cancelled: false })),
      answerPrompt: vi.fn(async () => undefined),
      setOption: vi.fn(async () => undefined),
      ...adapterExtras
    },
    journalDatabase: openTestJournalHostDatabase(root),
    claimKeyId: 'key-1',
    mintSpawnToken: () => `spawn-${acquire.mock.calls.length}`,
    now: () => NOW
  })
}

async function restartHost(): Promise<void> {
  await host.flushAllStreamedEvents()
  startHost()
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-child-record-'))
  resetHostTestOperationIds()
  adapterExtras = {}
  acquire = vi.fn(spawnChild)
  dispatch = vi.fn(async (input) => ({
    state: 'accepted' as const,
    providerIdentity: {
      provider: 'codex' as const,
      threadId: THREAD,
      turnId: `turn-${input.clientMessageId}`,
      ordinal: dispatch.mock.calls.length
    }
  }))
  store = await openTestAgentSessionRecordStore(root)
  startHost()
  expect(await host.attach(CALLER, hostTestAttachParams(null))).toMatchObject({ ok: true })
  await host.close(SESSION, 'evict')
})

afterEach(async () => {
  await host.flushAllStreamedEvents()
  await rm(root, { recursive: true, force: true })
})

function sendParams(text: string) {
  const body = hostTestMessage(text)
  return {
    envelope: {
      sessionId: SESSION,
      clientOperationId: hostTestOperationId(),
      expectedRuntimeFence: 1,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.send',
        sessionId: SESSION,
        fields: { body }
      })
    },
    body
  }
}

async function accept(text: string): Promise<string> {
  const params = sendParams(text)
  const sent = await host.send(CALLER, params)
  expect(sent).toMatchObject({ ok: true, value: { submission: { dispatchState: 'pending' } } })
  return params.envelope.clientOperationId
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

async function statusRows(): Promise<
  {
    itemId: string
    text: string
    tone?: string
    failure?: AgentSessionFailureFact
  }[]
> {
  return (await host.journalSnapshot(SESSION)).items.flatMap((item) =>
    item.body.kind === 'status'
      ? [
          {
            itemId: item.itemId,
            text: item.body.text,
            ...(item.body.tone ? { tone: item.body.tone } : {}),
            ...(item.body.failure ? { failure: item.body.failure } : {})
          }
        ]
      : []
  )
}

/** The child the conversation has now, as its lifecycle events name it. */
function currentChild() {
  const child = conversation()?.child
  if (!child?.generation) {
    throw new Error('no child indexed')
  }
  return { sessionId: SESSION, fence: child.fence, acquisitionGeneration: child.generation }
}

function exit(child: ReturnType<typeof currentChild>, reason: string, startupUnproven?: true) {
  return host.handleAdapterEvent({
    type: 'ended',
    ...child,
    reason,
    // As an adapter reports it: the exit's stderr as a log detail.
    failure: { kind: 'providerExited', detail: { text: reason, audience: 'log' } },
    cause: 'unexpected-exit',
    ...(startupUnproven ? { startupUnproven } : {})
  })
}

/** Whether a subscriber was told the message was rejected. */
function rejectedIn(events: AgentSessionSubscribeEvent[], id: string): boolean {
  return events.some(
    (event) =>
      event.type === 'batch' &&
      event.batch.submissions.some(
        (entry) => entry.clientMessageId === id && entry.dispatchState === 'rejected'
      )
  )
}

async function rejected(id: string): Promise<void> {
  await eventually(async () => expect((await submission(id))?.dispatchState).toBe('rejected'))
}

/** A queued message no start has failed, to read which fallback a per-message rejection names. */
const UNFAILED: AgentJournalSubmission = {
  clientMessageId: 'unfailed',
  fence: 0,
  payloadFingerprint: '',
  dispatchState: 'pending',
  providerItemId: null,
  reason: null,
  submittedAt: 0,
  resolvedAt: null
}

function conversation() {
  return host['sessions'].get(SESSION)
}

async function subscribe(): Promise<AgentSessionSubscribeEvent[]> {
  const events: AgentSessionSubscribeEvent[] = []
  await host.subscribe({
    id: 'sub-1',
    sessionId: SESSION,
    emit: (event) => events.push(structuredClone(event))
  })
  return events
}

/** The chat's status row as a session list sees it, frame by frame. */
function watchStatus(): AgentSessionStatusSummary[] {
  const frames: AgentSessionStatusSummary[] = []
  host.subscribeStatus({
    id: 'list-1',
    emit: (event) => {
      if (event.type === 'status' && event.session.sessionId === SESSION) {
        frames.push(event.session)
      }
    }
  })
  return frames
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

describe('Stop on a child still proving its start', () => {
  it('ends the child and keeps the conversation and its readers (R1)', async () => {
    const ended = deferred<void>()
    adapterExtras = {
      awaitStarted: vi.fn(() => ended.promise),
      closeSession: vi.fn(async () => {
        ended.resolve()
        return true
      })
    }
    await restartHost()
    acquire.mockImplementationOnce(spawnStartingChild)
    const first = await accept('hello')
    const journal = conversation()?.journal
    const events = await subscribe()
    const frames = watchStatus()
    await eventually(() => expect(conversation()?.child?.phase).toBe('starting'))

    expect(await stop()).toMatchObject({ ok: true, value: { cancelled: true } })

    // The same conversation: no reopen, and the chat told it is idle again.
    expect(conversation()?.journal).toBe(journal)
    expect(conversation()?.child).toBeNull()
    expect(conversation()?.lastEndedChild).toMatchObject({ cause: 'user-stop', rootGone: true })
    expect(frames.at(-1)).not.toHaveProperty('hostExecutionPhase')
    expect(frames.at(-1)).not.toHaveProperty('hostExecutionOwned')
    expect(await submission(first)).toMatchObject({
      dispatchState: 'rejected',
      reason: DISPATCH_REJECTED_CANCELLED
    })
    // A Stop is not a failure: no row, and the loop is gone.
    expect(await statusRows()).toEqual([])
    await eventually(() => expect(host['conversationDelivery'].loop.isRunning(SESSION)).toBe(false))

    const next = await accept('after stop')
    await eventually(async () => expect((await submission(next))?.dispatchState).toBe('accepted'))
    expect(conversation()?.journal).toBe(journal)
    expect(dispatch.mock.calls.map(([input]) => input.clientMessageId)).toEqual([next])
    // The reader opened before the Stop saw the next message delivered on the same stream.
    expect(
      events.some(
        (event) =>
          event.type === 'batch' &&
          event.batch.submissions.some(
            (entry) => entry.clientMessageId === next && entry.dispatchState === 'accepted'
          )
      )
    ).toBe(true)
  })
})

describe('settling an earlier child before the next one takes its message', () => {
  it("settles the earlier child's turn from its death evidence and leaves the queued message to the new child (R1)", async () => {
    // The earlier child exited mid-turn; the released lease keeps only its death evidence.
    await store.transitionHandoff(SESSION, (record) => ({
      ...record,
      lease: {
        ...record.lease,
        deathEvidence: { kind: 'exit-observed', detail: 'provider exited', observedAt: NOW - 1_000 }
      }
    }))
    const releasedFence = store.getRecord(SESSION)!.lease.runtimeFence
    const journal = await openAgentSessionJournal({
      identity: {
        sessionId: SESSION,
        workspaceId: HOST_TEST_LOCATION.workspaceId,
        hostId: HOST_TEST_LOCATION.executionHostId,
        agent: 'codex',
        providerHandle: codexProviderHandle(THREAD)
      },
      database: openTestJournalHostDatabase(root)
    })
    await journal.appendItem(
      { provider: 'codex', threadId: THREAD, turnId: 'earlier-turn', ordinal: 0 },
      { kind: 'turn', turnId: 'earlier-turn', state: 'running', startedAt: NOW - 5_000 },
      { fence: releasedFence, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    await journal.close()
    const id = await accept('for the next child')

    await eventually(async () => expect((await submission(id))?.dispatchState).toBe('accepted'))
    // The exit was observed, so its receipt ends the turn, and the chat says why it stopped.
    const items = conversation()!.journal.snapshot().items
    expect(items.map((item) => readAgentJournalTurn(item.body)).filter(Boolean)).toContainEqual(
      expect.objectContaining({
        turnId: 'earlier-turn',
        state: 'interrupted',
        completedAt: NOW - 1_000
      })
    )
    expect(
      items.flatMap((item) => (item.body.kind === 'status' ? [item.body.text] : []))
    ).toContain(
      'Codex stopped while this response was in progress. You can continue in this conversation.'
    )
    // Handed over at the new child's fence, which the attach reserved after settling.
    const newFence = store.getRecord(SESSION)!.lease.runtimeFence
    expect(newFence).toBeGreaterThan(releasedFence)
    expect((await submission(id))?.fence).toBe(newFence)
    expect(conversation()?.child).toMatchObject({ generation: generation(), fence: newFence })
  })
})

const START_EXIT = 'claude stream-json exited (code 1)'
const START_TEXT = 'Codex stopped before it finished starting. Send your message to try again.'
const START_FAILURE: SubmissionRejectionFact = {
  kind: 'providerStartFailed',
  detail: { text: START_EXIT, audience: 'log' }
}

describe('a published child that dies while it proves its start', () => {
  const EXIT = START_EXIT
  const TEXT = START_TEXT

  it.each([['the loop sees the start fail first'], ['the exit is processed first']])(
    'records the failure once on the message it was for, and the next message starts again: %s (R2)',
    async (order) => {
      const settled = deferred<SubmissionRejectionFact>()
      adapterExtras = { awaitStarted: vi.fn(() => settled.promise) }
      await restartHost()
      acquire.mockImplementation(spawnStartingChild)
      const first = await accept('first')
      const events = await subscribe()
      const second = await accept('second')
      await eventually(() => expect(adapterExtras.awaitStarted).toHaveBeenCalled())
      const child = currentChild()

      if (order === 'the exit is processed first') {
        await exit(child, EXIT, true)
        settled.resolve(START_FAILURE)
      } else {
        settled.resolve(START_FAILURE)
        await rejected(first)
        await exit(child, EXIT, true)
      }

      // The second goes on to a start of its own, which fails the same way.
      await rejected(second)
      expect(await statusRows()).toEqual([])
      for (const id of [first, second]) {
        expect(await submission(id)).toMatchObject({
          dispatchState: 'rejected',
          reason: TEXT,
          rejection: START_FAILURE
        })
        expect(await submission(id)).not.toHaveProperty('startRetry')
      }
      expect(rejectedIn(events, first)).toBe(true)
      expect(dispatch).not.toHaveBeenCalled()
      expect(acquire).toHaveBeenCalledTimes(3)
    }
  )
})

/** A start by an operation that needs the agent, such as a goal change, outside the loop. */
function startForOperation() {
  return host['serialize'](SESSION, () =>
    ensureStructuredAgentSessionAgent(host['attachContext'](), SESSION)
  )
}

describe('a start another operation made that dies while a sent message waits on it', () => {
  const EXIT = START_EXIT
  const TEXT = START_TEXT

  it("is the message's own failed start: recorded on it, with no second start (R2)", async () => {
    adapterExtras = { awaitStarted: vi.fn(async () => START_FAILURE) }
    await restartHost()
    acquire.mockImplementation(spawnStartingChild)
    // An operation that needs the agent starts a child that has not proven its start.
    await startForOperation()
    const operationChild = currentChild()
    const events = await subscribe()
    const params = sendParams('hello')

    // Accepted first; that child's exit is settled before the loop's first step.
    const sent = host.send(CALLER, params)
    const exited = exit(operationChild, EXIT, true)
    expect(await sent).toMatchObject({
      ok: true,
      value: { submission: { dispatchState: 'pending' } }
    })
    await exited
    const id = params.envelope.clientOperationId

    await rejected(id)
    await settleLoop()
    expect(await submission(id)).toMatchObject({
      dispatchState: 'rejected',
      reason: TEXT,
      rejection: { kind: 'providerStartFailed' }
    })
    expect(await submission(id)).not.toHaveProperty('startRetry')
    expect(await statusRows()).toEqual([])
    expect(rejectedIn(events, id)).toBe(true)
    // The setup's child and the operation's: nothing started again into the same failure.
    expect(acquire).toHaveBeenCalledTimes(2)
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('leaves a message sent after that start failed to a fresh start (R2)', async () => {
    await restartHost()
    acquire.mockImplementationOnce(spawnStartingChild)
    await startForOperation()
    await exit(currentChild(), EXIT, true)
    expect(await statusRows()).toEqual([])

    const id = await accept('after the failure')

    await eventually(async () => expect((await submission(id))?.dispatchState).toBe('accepted'))
    expect(acquire).toHaveBeenCalledTimes(3)
  })

  it('starts again for a message whose proven child crashed: only a failed start settles it (R2)', async () => {
    await restartHost()
    await startForOperation()
    const params = sendParams('hello')

    const sent = host.send(CALLER, params)
    const exited = exit(currentChild(), 'codex app-server crashed')
    await sent
    await exited
    const id = params.envelope.clientOperationId

    await eventually(async () => expect((await submission(id))?.dispatchState).not.toBe('pending'))
    expect((await submission(id))?.dispatchState).toBe('accepted')
    expect(acquire).toHaveBeenCalledTimes(3)
  })

  it('waits on a child started since the failed one, not on the failure (R2)', async () => {
    adapterExtras = { awaitStarted: vi.fn(async () => undefined) }
    await restartHost()
    acquire.mockImplementation(spawnStartingChild)
    await startForOperation()
    const params = sendParams('hello')

    // A second operation's start lands after the first child's exit, before the loop's first step.
    const sent = host.send(CALLER, params)
    const exited = exit(currentChild(), EXIT, true)
    const held = startForOperation()
    await sent
    await exited
    await held
    const id = params.envelope.clientOperationId

    await eventually(async () => expect((await submission(id))?.dispatchState).not.toBe('pending'))
    expect((await submission(id))?.dispatchState).toBe('accepted')
    expect(acquire).toHaveBeenCalledTimes(3)
  })
})

describe('a child that ends before its message is handed over', () => {
  it('starts one child for the message, then records its end on it and stops (R2)', async () => {
    // The child the loop starts exits between its start step and its handover step.
    adapterExtras = {
      awaitStarted: vi.fn(async () => {
        await exit(currentChild(), 'codex app-server crashed')
      })
    }
    await restartHost()
    const id = await accept('hello')
    const events = await subscribe()

    await rejected(id)
    // The exit's stderr rides beside the sentence, never in it.
    expect(await submission(id)).toMatchObject({
      dispatchState: 'rejected',
      reason: 'Codex stopped before this message was sent.',
      rejection: {
        kind: 'providerExited',
        detail: { text: 'codex app-server crashed', audience: 'log' }
      }
    })
    expect(await submission(id)).not.toHaveProperty('startRetry')
    expect(await statusRows()).toEqual([])
    expect(rejectedIn(events, id)).toBe(true)
    await eventually(() => expect(host['conversationDelivery'].loop.isRunning(SESSION)).toBe(false))
    expect(acquire).toHaveBeenCalledTimes(2)
    expect(dispatch).not.toHaveBeenCalled()
  })
})

describe('another child indexed while the loop waits on the one it started', () => {
  it('hands nothing over until the child now there has proven its start (R2)', async () => {
    const starts = new Map<string, ReturnType<typeof deferred<void>>>()
    const startOf = (generation: string) => {
      const start = starts.get(generation) ?? deferred<void>()
      starts.set(generation, start)
      return start
    }
    adapterExtras = {
      awaitStarted: vi.fn(() => startOf(currentChild().acquisitionGeneration).promise),
      // The stop ends the child without settling the start the loop is waiting on.
      closeSession: vi.fn(async () => true)
    }
    await restartHost()
    acquire.mockImplementation(spawnStartingChild)
    const first = await accept('first')
    await eventually(() => expect(adapterExtras.awaitStarted).toHaveBeenCalledTimes(1))
    const stopped = currentChild()
    expect(await stop()).toMatchObject({ ok: true })
    const second = await accept('second')
    // An operation that needs the agent starts its own child before the loop's handover step runs.
    await host['serialize'](SESSION, () =>
      ensureStructuredAgentSessionAgent(host['attachContext'](), SESSION)
    )
    const replacement = currentChild()
    expect(replacement.acquisitionGeneration).not.toBe(stopped.acquisitionGeneration)

    startOf(stopped.acquisitionGeneration).resolve()
    await eventually(() => expect(adapterExtras.awaitStarted).toHaveBeenCalledTimes(2))
    expect(dispatch).not.toHaveBeenCalled()

    await host.handleAdapterEvent({
      type: 'started',
      ...replacement,
      reportedOptions: { model: 'sonnet' },
      restoreSkippedOptions: []
    })
    startOf(replacement.acquisitionGeneration).resolve()

    await eventually(async () => expect((await submission(second))?.dispatchState).toBe('accepted'))
    expect(dispatch.mock.calls.map(([input]) => input.clientMessageId)).toEqual([second])
    expect(await submission(first)).toMatchObject({ reason: DISPATCH_REJECTED_CANCELLED })
  })
})

describe('a quit with a message still queued', () => {
  /** Read by the next launch, through the same open any reader takes. */
  async function afterRelaunch(id: string): Promise<AgentJournalSubmission | undefined> {
    startHost()
    await host.revealSession(SESSION)
    return await submission(id)
  }

  it('settles a message no child ever had the way a chat close does (R2)', async () => {
    // Quit has begun — its first step stops the delivery loops — when this message is accepted.
    host['conversationDelivery'].loop.dispose()
    const id = await accept('hello')
    expect(conversation()?.child).toBeNull()
    await host.flushAllStreamedEvents()

    expect(await afterRelaunch(id)).toMatchObject({
      dispatchState: 'rejected',
      ...agentSessionFailureWords(agentSessionFailureFact('chatClosed'), { surface: 'rejection' })
    })
  })

  it('waits for the start already in flight and stops the child it produced (R2)', async () => {
    const starting = deferred<void>()
    const closeSession = vi.fn(async () => true)
    adapterExtras = { closeSession }
    await restartHost()
    // The loop's start step is under way, but has not reached its attach yet.
    const resolveRecovery = host['runtimeState'].resolveRecovery.bind(host['runtimeState'])
    const recovering = vi.spyOn(host['runtimeState'], 'resolveRecovery')
    recovering.mockImplementationOnce(async (sessionId) => {
      await starting.promise
      return resolveRecovery(sessionId)
    })
    const id = await accept('hello')
    await eventually(() => expect(recovering).toHaveBeenCalled())

    const quit = host.flushAllStreamedEvents()
    starting.resolve()
    await quit

    expect(closeSession).toHaveBeenCalledWith(SESSION)
    expect(store.getRecord(SESSION)?.lease).toMatchObject({ claimStatus: 'released' })
    expect(dispatch).not.toHaveBeenCalled()
    expect(await afterRelaunch(id)).toMatchObject({
      dispatchState: 'rejected',
      ...agentSessionFailureWords(agentSessionFailureFact('chatClosed'), { surface: 'rejection' })
    })
  })
})

describe('a send whose start failed, sent again with the same operation id', () => {
  it('replays the recorded answer and starts no second agent (R2)', async () => {
    acquire.mockRejectedValueOnce(new Error('spawn claude ENOENT'))
    const fenceBefore = store.getRecord(SESSION)!.lease.runtimeFence
    const params = sendParams('hello')
    // A failed start rejects the accepted message, never the send.
    expect(await host.send(CALLER, params)).toMatchObject({
      ok: true,
      value: { submission: { dispatchState: 'pending' } }
    })
    const id = params.envelope.clientOperationId
    await rejected(id)
    // The start moved the fence while the message was out.
    expect(store.getRecord(SESSION)!.lease.runtimeFence).toBeGreaterThan(fenceBefore)
    await settleLoop()
    const starts = acquire.mock.calls.length

    const replay = await host.send(CALLER, params)

    expect(replay).toMatchObject({
      ok: true,
      replayed: true,
      value: {
        submission: {
          clientMessageId: id,
          dispatchState: 'rejected',
          rejection: { kind: 'restartFailed' }
        }
      }
    })
    await settleLoop()
    expect(acquire).toHaveBeenCalledTimes(starts)
    expect(dispatch).not.toHaveBeenCalled()
  })
})

async function settleLoop(): Promise<void> {
  await eventually(() => expect(host['conversationDelivery'].loop.isRunning(SESSION)).toBe(false))
}

describe('how a stopped child ends the start its loop was waiting on', () => {
  /** A child the loop waits on, whose start the stop below does not settle, so a message sent
   *  after the stop is queued when the loop next looks. */
  async function stoppedWhileStarting(stop: () => Promise<void>) {
    const start = deferred<void>()
    adapterExtras = {
      awaitStarted: vi.fn(() => start.promise),
      closeSession: vi.fn(async () => true)
    }
    await restartHost()
    acquire.mockImplementationOnce(spawnStartingChild)
    await accept('first')
    await eventually(() => expect(adapterExtras.awaitStarted).toHaveBeenCalledTimes(1))
    await stop()
    const second = await accept('second')
    adapterExtras.awaitStarted = undefined
    start.resolve()
    return second
  }

  it("goes on after a user's Stop and delivers what was sent since (R2)", async () => {
    const second = await stoppedWhileStarting(async () => {
      expect(await stop()).toMatchObject({ ok: true })
    })

    await eventually(async () => expect((await submission(second))?.dispatchState).toBe('accepted'))
    expect(conversation()?.lastEndedChild).toMatchObject({ cause: 'user-stop', reason: null })
    expect(await statusRows()).toEqual([])
  })

  /** The close's stop alone: a close that aborts after it leaves the conversation indexed. */
  function closeStopOnly() {
    return host['serialize'](SESSION, () =>
      stopStructuredAgentSessionAgentUnderSerialize(host['lifetimeContext'](), SESSION, {
        cause: 'user-close'
      })
    )
  }

  /** A message queued behind a starting child when the close's stop cut it. `beforeStart` runs
   *  after the stop and before the loop looks again. */
  async function closedWhileStarting(beforeStart: () => void = () => undefined) {
    const start = deferred<void>()
    adapterExtras = {
      awaitStarted: vi.fn(() => start.promise),
      closeSession: vi.fn(async () => true)
    }
    await restartHost()
    acquire.mockImplementationOnce(spawnStartingChild)
    const first = await accept('first')
    await eventually(() => expect(adapterExtras.awaitStarted).toHaveBeenCalledTimes(1))
    await closeStopOnly()
    const starts = acquire.mock.calls.length
    beforeStart()
    start.resolve()
    await settleLoop()
    return { first, starts }
  }

  it('closes what was queued when the user closed the chat, and starts no child for it', async () => {
    const { first, starts } = await closedWhileStarting()

    expect(await submission(first)).toMatchObject({
      dispatchState: 'rejected',
      ...CHAT_CLOSED
    })
    expect(acquire).toHaveBeenCalledTimes(starts)
    expect(dispatch).not.toHaveBeenCalled()
    expect(await statusRows()).toEqual([])
  })

  it('starts no child when closing what was queued fails, and closes it on the next wake', async () => {
    const { first, starts } = await closedWhileStarting(() => {
      const journal = conversation()!.journal
      const reject = journal.rejectQueuedSubmissions.bind(journal)
      vi.spyOn(journal, 'rejectQueuedSubmissions').mockImplementation(async (...args) => {
        const rejection = typeof args[1] === 'function' ? args[1](UNFAILED) : args[1]
        if (rejection.rejection.kind === 'chatClosed') {
          vi.mocked(journal.rejectQueuedSubmissions).mockImplementation(reject)
          throw new Error('disk full')
        }
        return reject(...args)
      })
    })

    expect((await submission(first))?.dispatchState).toBe('pending')
    expect(acquire).toHaveBeenCalledTimes(starts)
    expect(dispatch).not.toHaveBeenCalled()

    const second = await accept('second')
    await eventually(async () => expect((await submission(second))?.dispatchState).toBe('accepted'))
    expect(await submission(first)).toMatchObject({
      dispatchState: 'rejected',
      ...CHAT_CLOSED
    })
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  it('goes on with a message sent in a later epoch, whose sequence restarts at or below the close', async () => {
    await closedWhileStarting()
    const session = conversation()!
    await session.journal.rollEpoch(
      'corruption',
      structuredAgentSessionConversationFence(store, SESSION)
    )

    const second = await accept('second')

    await eventually(async () => expect((await submission(second))?.dispatchState).toBe('accepted'))
    expect(session.lastEndedChild).toMatchObject({ cause: 'user-close' })
    expect((await submission(second))!.acceptedSequence).toBeLessThanOrEqual(
      session.lastEndedChild!.endedAt.sequence
    )
  })

  it('goes on with a message sent after the close, never failing it', async () => {
    const second = await stoppedWhileStarting(closeStopOnly)

    await eventually(async () => expect((await submission(second))?.dispatchState).toBe('accepted'))
    expect(conversation()?.lastEndedChild).toMatchObject({ cause: 'user-close' })
    expect(await statusRows()).toEqual([])
  })

  it("fails the start after a host stop, as a start Orca stopped rather than the provider's (R2)", async () => {
    const reason = 'the start watchdog fired'
    const second = await stoppedWhileStarting(() =>
      host['serialize'](SESSION, () =>
        stopStructuredAgentSessionAgentUnderSerialize(host['lifetimeContext'](), SESSION, {
          cause: 'host-stop',
          reason
        })
      )
    )

    // The start was waited on for the first message, which takes its failure; the second goes on.
    await eventually(async () => expect((await submission(second))?.dispatchState).toBe('accepted'))
    const first = (await host.journalSnapshot(SESSION)).submissions[0]
    // The sentence is the constructor's, not the reason the stop was given.
    const text = 'Codex never finished starting, so Orca stopped it.'
    expect(first).toMatchObject({
      dispatchState: 'rejected',
      reason: text,
      rejection: { kind: 'hostStopped' }
    })
    expect(first).not.toHaveProperty('startRetry')
    expect(await statusRows()).toEqual([])
    expect(dispatch.mock.calls.map(([input]) => input.clientMessageId)).toEqual([second])
  })
})
