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
import {
  DISPATCH_REJECTED_CANCELLED,
  DISPATCH_REJECTED_PROVIDER_CLOSED
} from '../../../shared/structured-agent-session-dispatch-rejection'
import { providerStartupFailureOutcome } from './structured-agent-session-dead-generation-settlement'
import { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import { ensureStructuredAgentSessionAgent } from './structured-agent-session-agent-start'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import { stopStructuredAgentSessionAgentUnderSerialize } from './structured-agent-session-host-lifetime'
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
      closeSession: vi.fn(async () => true),
      releaseAcquisition: vi.fn(async () => true),
      cancelTurn: vi.fn(async () => ({ cancelled: false })),
      answerPrompt: vi.fn(async () => undefined),
      setOption: vi.fn(async () => undefined),
      ...adapterExtras
    },
    journalRoot: root,
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
  store = await AgentSessionRecordStore.open({ directory: join(root, 'store'), hostId: 'local' })
  startHost()
  expect(await host.attach(CALLER, hostTestAttachParams(null))).toMatchObject({ ok: true })
  await host.close(SESSION)
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
  return (await host.journalSnapshot(SESSION)).submissions.find((entry) => entry.clientMessageId === id)
}

async function statusRows(): Promise<{ itemId: string; text: string; tone?: string }[]> {
  return (await host.journalSnapshot(SESSION)).items.flatMap((item) =>
    item.body.kind === 'status'
      ? [
          {
            itemId: item.itemId,
            text: item.body.text,
            ...(item.body.tone ? { tone: item.body.tone } : {})
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

describe('a settlement retry for an earlier child inside the attach for the next one', () => {
  it('settles the earlier child and leaves the queued message to the new child (R1)', async () => {
    // The earlier child's settlement is still owed; the lease is otherwise released.
    await store.transitionHandoff(SESSION, (record) => ({
      ...record,
      lease: {
        ...record.lease,
        settlementRetryRequired: true,
        settlementRetryId: `provider-exit:${SESSION}:1:generation-1`
      }
    }))
    const retryFence = store.getRecord(SESSION)!.lease.runtimeFence
    const id = await accept('for the next child')

    await eventually(async () => expect((await submission(id))?.dispatchState).toBe('accepted'))
    expect(store.getRecord(SESSION)?.lease.settlementRetryRequired).toBeUndefined()
    // Handed over at the new child's fence, which the attach reserved after the retry.
    const newFence = store.getRecord(SESSION)!.lease.runtimeFence
    expect(newFence).toBeGreaterThan(retryFence)
    expect((await submission(id))?.fence).toBe(newFence)
    expect(conversation()?.child).toMatchObject({ generation: generation(), fence: newFence })
  })
})

describe('a published child that dies while it proves its start', () => {
  const EXIT = 'claude stream-json exited (code 1)'
  const TEXT = providerStartupFailureOutcome(EXIT)

  it.each([['the loop sees the start fail first'], ['the exit is processed first']])(
    'leaves one error row keyed by the start, and every queued message rejected with it: %s (R2)',
    async (order) => {
      const settled = deferred<string>()
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
        settled.resolve(TEXT)
      } else {
        settled.resolve(TEXT)
        await eventually(async () => expect((await submission(second))?.dispatchState).toBe('rejected'))
        await exit(child, EXIT, true)
      }

      await eventually(async () => expect((await submission(second))?.dispatchState).toBe('rejected'))
      expect(await statusRows()).toEqual([
        {
          itemId: `orca:${encodeURIComponent(`start-failure:${child.acquisitionGeneration}`)}`,
          text: TEXT,
          tone: 'error'
        }
      ])
      expect(await submission(first)).toMatchObject({ dispatchState: 'rejected', reason: TEXT })
      expect(await submission(second)).toMatchObject({ dispatchState: 'rejected', reason: TEXT })
      expect(rejectedIn(events, second)).toBe(true)
      expect(dispatch).not.toHaveBeenCalled()
      expect(acquire).toHaveBeenCalledTimes(2)
    }
  )
})

describe('a child that ends before its message is handed over', () => {
  it('starts one child for the message, then rejects it and stops (R2)', async () => {
    // The child the loop starts exits between its start step and its handover step.
    adapterExtras = {
      awaitStarted: vi.fn(async () => {
        await exit(currentChild(), 'codex app-server crashed')
      })
    }
    await restartHost()
    const id = await accept('hello')
    const events = await subscribe()

    await eventually(async () => expect((await submission(id))?.dispatchState).toBe('rejected'))
    expect((await submission(id))?.reason).toContain('codex app-server crashed')
    expect(await statusRows()).toEqual([
      { itemId: expect.any(String), text: (await submission(id))?.reason, tone: 'error' }
    ])
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
      reason: DISPATCH_REJECTED_PROVIDER_CLOSED
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
      reason: DISPATCH_REJECTED_PROVIDER_CLOSED
    })
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

  it('fails the start after a host stop, with the stop as the reason (R2)', async () => {
    const reason = 'Claude never finished starting, so Orca stopped it.'
    const second = await stoppedWhileStarting(() =>
      host['serialize'](SESSION, () =>
        stopStructuredAgentSessionAgentUnderSerialize(host['lifetimeContext'](), SESSION, {
          cause: 'host-stop',
          reason
        })
      )
    )

    await eventually(async () => expect((await submission(second))?.dispatchState).toBe('rejected'))
    expect((await submission(second))?.reason).toBe(reason)
    expect(await statusRows()).toEqual([{ itemId: expect.any(String), text: reason, tone: 'error' }])
    expect(dispatch).not.toHaveBeenCalled()
  })
})
