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
import { structuredQueuePauses } from './structured-agent-session-queued-pause'
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
import { NO_STRUCTURED_AGENTS } from './structured-agent-session-adapter-router-test-support'

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
    agents: NO_STRUCTURED_AGENTS,
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

async function accept(text: string, options: { person?: true } = {}): Promise<string> {
  const params = sendParams(text)
  const sent = await host.send(CALLER, { ...params, ...(options.person ? { userSend: true } : {}) })
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

function rejectedIn(events: AgentSessionSubscribeEvent[], id: string): boolean {
  return events.some(
    (event) =>
      event.type === 'batch' &&
      event.batch.submissions.some(
        (entry) => entry.clientMessageId === id && entry.dispatchState === 'rejected'
      )
  )
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
    adapterExtras = { closeSession: vi.fn(async () => true) }
    await restartHost()
    acquire.mockImplementationOnce(spawnStartingChild)
    // Written to the starting child at once; it never answers.
    dispatch.mockResolvedValueOnce({ state: 'admitted' })
    const first = await accept('hello')
    const journal = conversation()?.journal
    const events = await subscribe()
    const frames = watchStatus()
    await eventually(() => expect(conversation()?.child?.phase).toBe('starting'))
    await eventually(async () => expect((await submission(first))?.handedOverAt).toBeDefined())

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
    expect(dispatch.mock.calls.map(([input]) => input.clientMessageId)).toEqual([first, next])
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

  it('leaves one error row keyed by the start, and every message it was handed rejected with it (R2)', async () => {
    await restartHost()
    acquire.mockImplementation(spawnStartingChild)
    // The first is written to the starting child at once; it never answers, so its turn never
    // opens and the second waits behind it.
    dispatch.mockImplementation(async () => ({ state: 'admitted' as const }))
    const first = await accept('first')
    const events = await subscribe()
    const second = await accept('second')
    await eventually(() => expect(dispatch).toHaveBeenCalledTimes(1))
    const child = currentChild()

    await exit(child, EXIT, true)

    await eventually(async () => expect((await submission(second))?.dispatchState).toBe('rejected'))
    expect(await statusRows()).toEqual([
      {
        itemId: `orca:${encodeURIComponent(`start-failure:${child.acquisitionGeneration}`)}`,
        text: TEXT,
        tone: 'error',
        failure: START_FAILURE
      }
    ])
    for (const id of [first, second]) {
      expect(await submission(id)).toMatchObject({
        dispatchState: 'rejected',
        reason: TEXT,
        rejection: START_FAILURE
      })
    }
    expect(rejectedIn(events, second)).toBe(true)
    expect(acquire).toHaveBeenCalledTimes(2)
  })
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

  it("is the message's own failed start: one error row, the message rejected, no second start (R2)", async () => {
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

    await eventually(async () => expect((await submission(id))?.dispatchState).toBe('rejected'))
    await settleLoop()
    expect((await submission(id))?.reason).toBe(TEXT)
    expect(await statusRows()).toEqual([
      {
        itemId: `orca:${encodeURIComponent(`start-failure:${operationChild.acquisitionGeneration}`)}`,
        text: TEXT,
        tone: 'error',
        failure: START_FAILURE
      }
    ])
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
    expect(await statusRows()).toHaveLength(1)

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

  it('hands over to a child started since the failed one, not to the failure (R2)', async () => {
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
  it('starts one child for the message, then rejects it and stops (R2)', async () => {
    await restartHost()
    // The child the loop starts exits as its start step returns: that exit, asked for on the lane
    // then, lands before the handover step.
    acquire.mockImplementation(async (input) => {
      const child = await spawnChild(input)
      const { acquisitionGeneration } = child
      if (acquisitionGeneration === undefined) {
        throw new Error('spawnChild always names a generation')
      }
      void host.handleAdapterEvent({
        type: 'ended',
        sessionId: SESSION,
        fence: input.fence,
        acquisitionGeneration,
        reason: 'codex app-server crashed',
        failure: {
          kind: 'providerExited',
          detail: { text: 'codex app-server crashed', audience: 'log' }
        },
        cause: 'unexpected-exit'
      })
      return child
    })
    const id = await accept('hello')
    const events = await subscribe()

    await eventually(async () => expect((await submission(id))?.dispatchState).toBe('rejected'))
    // The exit's stderr rides beside the sentence, never in it.
    const failure = {
      kind: 'providerExited',
      detail: { text: 'codex app-server crashed', audience: 'log' }
    }
    expect(await submission(id)).toMatchObject({
      reason: 'Codex stopped before this message was sent.',
      rejection: failure
    })
    expect(await statusRows()).toEqual([
      { itemId: expect.any(String), text: (await submission(id))?.reason, tone: 'error', failure }
    ])
    expect(rejectedIn(events, id)).toBe(true)
    await eventually(() => expect(host['conversationDelivery'].loop.isRunning(SESSION)).toBe(false))
    expect(acquire).toHaveBeenCalledTimes(2)
    expect(dispatch).not.toHaveBeenCalled()
  })
})

describe('another child indexed after a Stop ended the starting one', () => {
  it('hands the next message to the child now there, still starting (R2)', async () => {
    adapterExtras = { closeSession: vi.fn(async () => true) }
    await restartHost()
    acquire.mockImplementation(spawnStartingChild)
    // The starting child takes the first message at once and never answers it.
    dispatch.mockResolvedValueOnce({ state: 'admitted' })
    const first = await accept('first')
    await eventually(() => expect(dispatch).toHaveBeenCalledTimes(1))
    const stopped = currentChild()
    expect(await stop()).toMatchObject({ ok: true })
    // An operation that needs the agent starts its own child before the second message is sent.
    await host['serialize'](SESSION, () =>
      ensureStructuredAgentSessionAgent(host['attachContext'](), SESSION)
    )
    const replacement = currentChild()
    expect(replacement.acquisitionGeneration).not.toBe(stopped.acquisitionGeneration)
    const secondId = await accept('second')

    await eventually(async () =>
      expect((await submission(secondId))?.dispatchState).toBe('accepted')
    )
    expect(conversation()?.child).toMatchObject({
      generation: replacement.acquisitionGeneration,
      phase: 'starting'
    })
    expect(dispatch.mock.calls.map(([input]) => input.clientMessageId)).toEqual([first, secondId])
    expect(acquire).toHaveBeenCalledTimes(3)
    expect(await submission(first)).toMatchObject({ reason: DISPATCH_REJECTED_CANCELLED })
  })
})

// A quit settles nothing still queued: the next launch's open keeps a person's message as a held
// card and rejects the rest, as a crash's would.
describe('a quit with a message still queued', () => {
  const HOST_RESTARTED = agentSessionFailureWords(agentSessionFailureFact('hostRestarted'), {
    surface: 'rejection'
  })

  /** Read by the next launch, through the same open any reader takes. */
  async function afterRelaunch(id: string): Promise<AgentJournalSubmission | undefined> {
    startHost()
    await host.revealSession(SESSION)
    return await submission(id)
  }

  async function keptCards(): Promise<string[]> {
    const page = await host.history({ sessionId: SESSION, direction: 'tail' })
    return page.ok ? (page.page.queuedMessages ?? []).map((card) => card.messageId) : []
  }

  it('keeps a person’s message no child ever had as a held card for the next launch (R2)', async () => {
    // Quit has begun — its first step stops the delivery loops — when this message is accepted.
    host['conversationDelivery'].loop.dispose()
    const id = await accept('hello', { person: true })
    expect(conversation()?.child).toBeNull()
    await host.flushAllStreamedEvents()

    expect(await afterRelaunch(id)).toMatchObject({ dispatchState: 'rejected', ...HOST_RESTARTED })
    expect(await keptCards()).toEqual([id])
    expect(dispatch).not.toHaveBeenCalled()
  })

  it("rejects a message from Orca itself at the next launch, as a crash's would", async () => {
    host['conversationDelivery'].loop.dispose()
    const id = await accept('from orca')
    await host.flushAllStreamedEvents()

    expect(await afterRelaunch(id)).toMatchObject({ dispatchState: 'rejected', ...HOST_RESTARTED })
    expect(await keptCards()).toEqual([])
  })

  it('stops a start already in flight before it launches a child (R2)', async () => {
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
    const id = await accept('hello', { person: true })
    await eventually(() => expect(recovering).toHaveBeenCalled())
    const acquiresBefore = acquire.mock.calls.length

    const quit = host.flushAllStreamedEvents()
    starting.resolve()
    await quit

    // Quit aborts the start, so nothing is launched behind it and nothing is left to stop.
    expect(acquire).toHaveBeenCalledTimes(acquiresBefore)
    expect(closeSession).not.toHaveBeenCalled()
    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      claimStatus: 'released',
      ownerProcess: null,
      deathEvidence: { detail: 'reservation failed before spawn' }
    })
    expect(dispatch).not.toHaveBeenCalled()
    expect(await afterRelaunch(id)).toMatchObject({ dispatchState: 'rejected', ...HOST_RESTARTED })
    expect(await keptCards()).toEqual([id])
  })
})

describe('a send whose start failed, sent again with the same operation id', () => {
  it('replays the recorded rejection and starts no second agent (R2)', async () => {
    acquire.mockRejectedValueOnce(new Error('spawn claude ENOENT'))
    const fenceBefore = store.getRecord(SESSION)!.lease.runtimeFence
    const params = sendParams('hello')
    // A failed start is a rejected message, never a refused send.
    expect(await host.send(CALLER, params)).toMatchObject({
      ok: true,
      value: { submission: { dispatchState: 'pending' } }
    })
    const id = params.envelope.clientOperationId
    await eventually(async () => expect((await submission(id))?.dispatchState).toBe('rejected'))
    // The start moved the fence while the message was out.
    expect(store.getRecord(SESSION)!.lease.runtimeFence).toBeGreaterThan(fenceBefore)
    const starts = acquire.mock.calls.length

    const replay = await host.send(CALLER, params)

    expect(replay).toMatchObject({
      ok: true,
      replayed: true,
      value: { submission: { clientMessageId: id, dispatchState: 'rejected' } }
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
  /** A starting child that took the first message and never answered it, then the stop below;
   *  the message sent after the stop is the next delivery's. */
  async function stoppedWhileStarting(stop: () => Promise<void>) {
    adapterExtras = { closeSession: vi.fn(async () => true) }
    await restartHost()
    acquire.mockImplementationOnce(spawnStartingChild)
    dispatch.mockResolvedValueOnce({ state: 'admitted' })
    await accept('first')
    await eventually(() => expect(dispatch).toHaveBeenCalledTimes(1))
    await stop()
    return accept('second')
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

  /** A message queued for a starting child when the close's stop cut it: asked for during the
   *  start step, the stop runs before the handover. `beforeStart` runs after the stop and before
   *  the loop looks again. */
  async function closedWhileStarting(beforeStart: () => void = () => undefined) {
    const start = deferred<void>()
    adapterExtras = { closeSession: vi.fn(async () => true) }
    await restartHost()
    acquire.mockImplementationOnce(async (input) => {
      await start.promise
      return spawnStartingChild(input)
    })
    const first = await accept('first')
    await eventually(() => expect(acquire).toHaveBeenCalledTimes(2))
    let starts = 0
    const closed = host['serialize'](SESSION, async () => {
      await stopStructuredAgentSessionAgentUnderSerialize(host['lifetimeContext'](), SESSION, {
        cause: 'user-close'
      })
      starts = acquire.mock.calls.length
      beforeStart()
    })
    start.resolve()
    await closed
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

  it('keeps a person’s message the user closed as a waiting card, and starts no child for it', async () => {
    const start = deferred<void>()
    adapterExtras = { closeSession: vi.fn(async () => true) }
    await restartHost()
    // The start step holds the queue: the message is still queued when the close's stop runs.
    acquire.mockImplementationOnce(async (input) => {
      await start.promise
      return spawnStartingChild(input)
    })
    const first = await accept('first', { person: true })
    await eventually(() => expect(acquire).toHaveBeenCalledTimes(2))
    let starts = 0
    const closed = closeStopOnly().then(() => {
      starts = acquire.mock.calls.length
    })
    start.resolve()
    await closed
    await settleLoop()

    expect(await submission(first)).toMatchObject({ dispatchState: 'rejected', ...CHAT_CLOSED })
    const page = await host.history({ sessionId: SESSION, direction: 'tail' })
    expect(page.ok && page.page.queuedMessages?.map((card) => card.messageId)).toEqual([first])
    expect(acquire).toHaveBeenCalledTimes(starts)
    expect(dispatch).not.toHaveBeenCalled()
    // The close stopped the chat running: the card waits for its next turn, by a mark the
    // re-check wrote once, when it kept the card.
    const journal = conversation()!.journal
    expect(structuredQueuePauses(journal).map((pause) => pause.reason)).toEqual(['restarted'])
    const marks = vi.spyOn(journal, 'appendQueueReopen')
    await accept('second', { person: true })
    await settleLoop()
    // A later send's re-check settles nothing, so it marks nothing past that send.
    expect(marks).not.toHaveBeenCalled()
  })

  it('starts no child when closing what was queued fails, and closes it on the next wake', async () => {
    const { first, starts } = await closedWhileStarting(() => {
      const journal = conversation()!.journal
      const resolve = journal.resolveDispatch.bind(journal)
      vi.spyOn(journal, 'resolveDispatch').mockImplementation(async (...args) => {
        if (args[0].state === 'rejected' && args[0].rejection?.kind === 'chatClosed') {
          vi.mocked(journal.resolveDispatch).mockImplementation(resolve)
          throw new Error('disk full')
        }
        return resolve(...args)
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
    adapterExtras = { closeSession: vi.fn(async () => true) }
    await restartHost()
    acquire.mockImplementationOnce(spawnStartingChild)
    dispatch.mockResolvedValueOnce({ state: 'admitted' })
    const first = await accept('first')
    await eventually(() => expect(dispatch).toHaveBeenCalledTimes(1))
    await host['serialize'](SESSION, () =>
      stopStructuredAgentSessionAgentUnderSerialize(host['lifetimeContext'](), SESSION, {
        cause: 'host-stop',
        reason
      })
    )

    // What the stopped start was handed fails with it, said once; a later send starts afresh.
    await eventually(async () => expect((await submission(first))?.dispatchState).toBe('rejected'))
    // The sentence is the constructor's, not the reason the stop was given.
    const text = 'Codex never finished starting, so Orca stopped it.'
    expect(await submission(first)).toMatchObject({
      reason: text,
      rejection: { kind: 'hostStopped' }
    })
    expect(await statusRows()).toEqual([
      { itemId: expect.any(String), text, tone: 'error', failure: { kind: 'hostStopped' } }
    ])
    const second = await accept('second')
    await eventually(async () => expect((await submission(second))?.dispatchState).toBe('accepted'))
  })
})
