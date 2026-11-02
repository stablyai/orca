// The host's startup attempt and its hold on delivery, against the real host, store and journal
// with a scripted adapter. A send to a chat whose agent is still starting is accepted at once and
// handed over only once the start proves itself; every way a start ends settles what was held.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { DISPATCH_REJECTED_CANCELLED } from '../../../shared/structured-agent-session-dispatch-rejection'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import type {
  AgentSessionAcquisition,
  StructuredAgentSessionAcquireInput,
  StructuredAgentSessionAdapter
} from './structured-agent-session-adapter'
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
import type { StructuredAgentSessionStartupLimits } from './structured-agent-session-startup-attempt-contract'

const CALLER = { callerKey: 'client-1' }

const eventually = (assertion: () => void | Promise<void>, interval = 0): Promise<void> =>
  vi.waitFor(assertion, { timeout: 10_000, interval })

let root: string
let store: AgentSessionRecordStore
let host: StructuredAgentSessionHost
let acquire: Mock<StructuredAgentSessionAdapter['acquire']>
let dispatch: Mock<StructuredAgentSessionAdapter['dispatch']>
let closeSession: Mock<NonNullable<StructuredAgentSessionAdapter['closeSession']>>
let setOption: Mock<StructuredAgentSessionAdapter['setOption']>
let startupLimits: Partial<StructuredAgentSessionStartupLimits> | undefined
const providerStarted = vi.fn()

function acquisition(input: StructuredAgentSessionAcquireInput): AgentSessionAcquisition {
  return {
    providerChildPhase: 'starting' as const,
    process: {
      hostId: 'local',
      pid: 4242,
      processStartTimeMs: 1_700_000_000_000,
      spawnToken: input.spawnToken
    },
    acquisitionGeneration: `generation-${acquire.mock.calls.length}`,
    link: {
      linkId: `link-${input.fence}`,
      handle: codexProviderHandle(THREAD),
      origin: store.getRecord(SESSION)?.providerHandleChain.length ? 'resumed' : 'created',
      mintedAtFence: input.fence,
      observedAt: NOW
    }
  }
}

/** An acquire that publishes at spawn, as every one does: the child proves its start later. */
const publishFirst: StructuredAgentSessionAdapter['acquire'] = async (input) => acquisition(input)

async function startHost(): Promise<void> {
  host = new StructuredAgentSessionHost({
    agents: NO_STRUCTURED_AGENTS,
    logger: createStructuredAgentSessionLogger(),
    store,
    adapter: {
      acquire,
      dispatch,
      closeSession,
      releaseAcquisition: vi.fn(async () => true),
      cancelTurn: vi.fn(async () => ({ cancelled: false })),
      answerPrompt: vi.fn(async () => undefined),
      setOption
    },
    modelCatalog: {
      read: vi.fn(async () => ({ origin: 'unknown' as const })),
      retainedLiveModelIds: vi.fn(() => []),
      recordLiveListing: vi.fn(),
      prewarm: vi.fn(async () => {}),
      stop: vi.fn(),
      providerStarted
    },
    journalDatabase: openTestJournalHostDatabase(root),
    claimKeyId: 'key-1',
    mintSpawnToken: () => `spawn-${acquire.mock.calls.length}`,
    idleSweep: { intervalMs: 60 * 60_000, idleMs: 60 * 60_000 },
    ...(startupLimits === undefined ? {} : { startupLimits }),
    now: () => NOW
  })
}

/** A fresh host with no child, so the next send starts one through `acquire`. */
async function restartWith(next: StructuredAgentSessionAdapter['acquire']): Promise<void> {
  await host.close(SESSION, 'evict')
  await host.flushAllStreamedEvents()
  acquire.mockImplementation(next)
  closeSession.mockClear()
  await startHost()
}

beforeEach(async () => {
  vi.useFakeTimers({
    toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval']
  })
  root = await mkdtemp(join(tmpdir(), 'orca-startup-attempt-'))
  resetHostTestOperationIds()
  startupLimits = undefined
  providerStarted.mockReset()
  acquire = vi.fn(async (input) => acquisition(input))
  dispatch = vi.fn(async () => ({
    state: 'accepted' as const,
    providerIdentity: {
      provider: 'codex' as const,
      threadId: THREAD,
      turnId: `turn-${dispatch.mock.calls.length}`,
      ordinal: dispatch.mock.calls.length
    }
  }))
  closeSession = vi.fn(async () => true)
  setOption = vi.fn(async () => undefined)
  store = await openTestAgentSessionRecordStore(root)
  await startHost()
  expect(await host.attach(CALLER, hostTestAttachParams(null))).toMatchObject({ ok: true })
})

afterEach(async () => {
  try {
    await host.flushAllStreamedEvents()
    await rm(root, { recursive: true, force: true })
  } finally {
    vi.useRealTimers()
  }
})

function sendParams(text: string, clientOperationId = hostTestOperationId()) {
  const body = hostTestMessage(text)
  return {
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
  }
}

async function accept(text: string, clientOperationId?: string): Promise<string> {
  const params = sendParams(text, clientOperationId)
  expect(await host.send(CALLER, params)).toMatchObject({
    ok: true,
    value: { submission: { dispatchState: 'pending', handoverRecorded: true } }
  })
  return params.envelope.clientOperationId
}

async function submission(id: string): Promise<AgentJournalSubmission | undefined> {
  return (await host.journalSnapshot(SESSION)).submissions.find(
    (entry) => entry.clientMessageId === id
  )
}

function startedEvent(generation = `generation-${acquire.mock.calls.length}`) {
  return {
    type: 'started' as const,
    sessionId: SESSION,
    fence: store.getRecord(SESSION)!.lease.runtimeFence,
    acquisitionGeneration: generation,
    reportedOptions: { model: 'default' }
  }
}

/** The send's start has published its child, still starting; the host holds the send. */
async function heldBehindStart(text: string, interval = 0): Promise<string> {
  const id = await accept(text)
  await eventually(
    async () =>
      expect((await host.readStatusSummary(SESSION))?.hostExecutionPhase).toBe('starting'),
    interval
  )
  return id
}

function stop() {
  return host.cancel(CALLER, {
    envelope: {
      sessionId: SESSION,
      clientOperationId: hostTestOperationId(),
      expectedRuntimeFence: null,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.cancel',
        sessionId: SESSION,
        fields: { turnId: 'turn-none' }
      })
    },
    turnId: 'turn-none'
  })
}

const HOST_STOPPED = agentSessionFailureWords(agentSessionFailureFact('hostStopped'), {
  agentName: 'Codex',
  surface: 'rejection'
})

describe('a send while the agent starts', () => {
  it('is accepted at once and handed over only once the start proves itself', async () => {
    await restartWith(publishFirst)
    const id = await heldBehindStart('hello')

    expect(await submission(id)).toMatchObject({ dispatchState: 'pending' })
    expect((await submission(id))?.handedOverAt).toBeUndefined()
    expect(dispatch).not.toHaveBeenCalled()

    await host.handleAdapterEvent(startedEvent())

    await eventually(async () => expect((await submission(id))?.dispatchState).toBe('accepted'))
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  it('hands every message held behind the start over, in order, once', async () => {
    await restartWith(publishFirst)
    const first = await heldBehindStart('first')
    const second = await accept('second')
    // The same id again is the same message: it is recorded and handed over once.
    await accept('first', first)

    await host.handleAdapterEvent(startedEvent())

    await eventually(async () => expect((await submission(second))?.dispatchState).toBe('accepted'))
    expect(dispatch.mock.calls.map(([input]) => input.clientMessageId)).toEqual([first, second])
  })

  it('ignores a start proof from a child it no longer holds', async () => {
    await restartWith(publishFirst)
    const id = await heldBehindStart('hello')

    await host.handleAdapterEvent(startedEvent('generation-stale'))
    await host.handleAdapterEvent({ ...startedEvent(), fence: startedEvent().fence + 1 })
    await host.flushStreamedEvents(SESSION)

    expect(dispatch).not.toHaveBeenCalled()
    expect((await host.readStatusSummary(SESSION))?.hostExecutionPhase).toBe('starting')
    await host.handleAdapterEvent(startedEvent())
    await eventually(async () => expect((await submission(id))?.dispatchState).toBe('accepted'))
  })

  it('tells the model catalog once the start proves itself, never for a child it no longer holds', async () => {
    await restartWith(publishFirst)
    providerStarted.mockClear()
    const id = await heldBehindStart('hello')
    expect(providerStarted).not.toHaveBeenCalled()

    await host.handleAdapterEvent(startedEvent('generation-stale'))
    await host.flushStreamedEvents(SESSION)
    expect(providerStarted).not.toHaveBeenCalled()

    await host.handleAdapterEvent(startedEvent())
    await eventually(async () => expect((await submission(id))?.dispatchState).toBe('accepted'))
    expect(providerStarted).toHaveBeenCalledTimes(1)
    expect(providerStarted.mock.calls[0]?.[0]).toMatchObject({ sessionId: SESSION })
  })
})

describe('a start that ends before it proves itself', () => {
  it('settles what it held as never sent when the agent exits during startup', async () => {
    await restartWith(publishFirst)
    const id = await heldBehindStart('hello')

    await host.handleAdapterEvent({
      type: 'ended',
      sessionId: SESSION,
      fence: store.getRecord(SESSION)!.lease.runtimeFence,
      acquisitionGeneration: `generation-${acquire.mock.calls.length}`,
      reason: 'exited with code 1',
      cause: 'unexpected-exit',
      startupUnproven: true
    })

    await eventually(async () => expect((await submission(id))?.dispatchState).toBe('rejected'))
    expect((await submission(id))?.handedOverAt).toBeUndefined()
    expect(dispatch).not.toHaveBeenCalled()
    expect(startupAttemptOpen()).toBe(false)
  })

  it('withdraws what it held on a Stop, without waiting on the handshake', async () => {
    await restartWith(publishFirst)
    const id = await heldBehindStart('hello')

    expect(await stop()).toMatchObject({ ok: true, value: { cancelled: true } })

    expect(await submission(id)).toMatchObject({
      dispatchState: 'rejected',
      reason: DISPATCH_REJECTED_CANCELLED
    })
    expect((await submission(id))?.handedOverAt).toBeUndefined()
    expect(closeSession).toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
    expect(startupAttemptOpen()).toBe(false)
  })

  it('keeps what it held for the chat on a close, without waiting on the handshake', async () => {
    await restartWith(publishFirst)
    const id = await heldBehindStart('hello')

    await host.close(SESSION, 'user-close')

    await host.revealSession(SESSION)
    expect(await submission(id)).toMatchObject({
      dispatchState: 'rejected',
      ...agentSessionFailureWords(agentSessionFailureFact('chatClosed'), { surface: 'rejection' })
    })
    expect((await submission(id))?.handedOverAt).toBeUndefined()
    expect(dispatch).not.toHaveBeenCalled()
    expect(startupAttemptOpen()).toBe(false)
  })

  it('stops a published start that goes silent and fails what it held', async () => {
    startupLimits = { silenceMs: 50 }
    await restartWith(publishFirst)
    const id = await heldBehindStart('hello')

    await eventually(async () => expect((await submission(id))?.dispatchState).toBe('rejected'), 50)
    expect(await submission(id)).toMatchObject(HOST_STOPPED)
    expect((await submission(id))?.handedOverAt).toBeUndefined()
    expect(closeSession).toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
    expect(startupAttemptOpen()).toBe(false)
  })

  it('keeps a slow start that is still talking, and stops one that never readies at the ceiling', async () => {
    startupLimits = { silenceMs: 50, ceilingMs: 400 }
    const chatter: ReturnType<typeof setInterval>[] = []
    await restartWith(async (input) => {
      await input.onSpawned?.(acquisition(input).process)
      chatter.push(setInterval(() => input.onOutput?.(), 10))
      return acquisition(input)
    })
    try {
      const id = await heldBehindStart('hello')
      await vi.advanceTimersByTimeAsync(200)
      expect(closeSession).not.toHaveBeenCalled()
      expect(startupAttemptOpen()).toBe(true)

      await eventually(
        async () => expect((await submission(id))?.dispatchState).toBe('rejected'),
        50
      )
      expect(await submission(id)).toMatchObject(HOST_STOPPED)
      expect(dispatch).not.toHaveBeenCalled()
    } finally {
      chatter.forEach(clearInterval)
    }
  })

  it('aborts an acquire still in its handshake once it goes silent and fails what it held', async () => {
    startupLimits = { silenceMs: 50 }
    await restartWith(
      (input) =>
        new Promise((_resolve, reject) => {
          void input.onSpawned?.(acquisition(input).process)
          input.signal?.addEventListener('abort', () => reject(input.signal?.reason))
        })
    )
    const id = await accept('hello')

    await eventually(async () => expect((await submission(id))?.dispatchState).toBe('rejected'), 50)
    expect(await submission(id)).toMatchObject(HOST_STOPPED)
    expect(dispatch).not.toHaveBeenCalled()
    await eventually(() => expect(startupAttemptOpen()).toBe(false))
  })

  it('ends a start whose acquire is still running when the chat closes', async () => {
    let land = (): void => {}
    const landed = new Promise<void>((resolve) => {
      land = resolve
    })
    await restartWith(async (input) => {
      await landed
      return acquisition(input)
    })
    const id = await accept('hello')
    await eventually(() => expect(acquire).toHaveBeenCalled())

    const closing = host.close(SESSION, 'evict')
    land()
    await expect(closing).resolves.toBeUndefined()

    await eventually(async () => expect((await submission(id))?.dispatchState).toBe('rejected'))
    expect((await submission(id))?.rejection).toMatchObject({ kind: 'chatClosed' })
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('is not ended by the limit once it proved itself', async () => {
    startupLimits = { silenceMs: 50 }
    await restartWith(publishFirst)
    const id = await heldBehindStart('hello', 0)
    await host.handleAdapterEvent(startedEvent())
    await eventually(async () => expect((await submission(id))?.dispatchState).toBe('accepted'), 0)

    await vi.advanceTimersByTimeAsync(100)

    expect(closeSession).not.toHaveBeenCalled()
    expect((await host.readStatusSummary(SESSION))?.hostExecutionPhase).toBe('ready')
    expect(startupAttemptOpen()).toBe(false)
  })
})

describe('what a started child reports', () => {
  it('keeps provider reports out of the saved next-message choice', async () => {
    await restartWith(publishFirst)
    const id = await heldBehindStart('hello')
    await host.handleAdapterEvent({ ...startedEvent(), reportedOptions: { model: 'reported' } })
    await eventually(async () => expect((await submission(id))?.dispatchState).toBe('accepted'))
    await host.handleAdapterEvent({
      ...startedEvent(),
      type: 'options-reported',
      reportedOptions: { model: 'from-settings' }
    })
    await host.flushStreamedEvents(SESSION)
    expect(store.getRecord(SESSION)?.options).toBeUndefined()
  })

  it('preserves a later accepted pick when an older child reports options', async () => {
    await restartWith(publishFirst)
    const id = await heldBehindStart('hello')
    await store.replaceSessionOptions({
      sessionId: SESSION,
      fence: store.getRecord(SESSION)!.lease.runtimeFence,
      options: { model: 'picked' },
      now: NOW
    })
    await host.handleAdapterEvent({ ...startedEvent(), reportedOptions: { model: 'reported' } })
    await eventually(async () => expect((await submission(id))?.dispatchState).toBe('accepted'))
    await host.handleAdapterEvent({
      ...startedEvent(),
      type: 'options-reported',
      reportedOptions: { model: 'from-settings' }
    })
    await host.flushStreamedEvents(SESSION)
    expect(store.getRecord(SESSION)?.options).toEqual({ model: 'picked' })
  })
})

function startupAttemptOpen(): boolean {
  return host.collaboratorsForTests().runtimeState.startupAttempts.isOpen(SESSION)
}

describe('the attempt an acquire runs under', () => {
  it('is minted by the host with the lease, the pinned launch and its progress report', async () => {
    await restartWith(publishFirst)
    await heldBehindStart('hello')

    const record = store.getRecord(SESSION)!
    const [input] = acquire.mock.calls.at(-1)!
    expect(input).toMatchObject({
      fence: record.lease.runtimeFence,
      launch: { location: record.location, accountHome: record.accountHome }
    })
    expect(input.onOutput).toEqual(expect.any(Function))
    expect(input.attemptId).toEqual(expect.any(String))
    expect(input.signal).toBeInstanceOf(AbortSignal)
  })
})

describe('a chat after startup permission backfill', () => {
  it.each(['ask', 'full-access'] as const)(
    'keeps %s before and after the first start, regardless of later Arguments',
    async (mode) => {
      await host.close(SESSION, 'evict')
      await store.backfillChatPermissionModes(() => mode === 'full-access')
      expect((await host.readOptions(SESSION)).current.permissionMode).toBe(mode)
      await store.backfillChatPermissionModes(() => mode === 'ask')
      await restartWith(publishFirst)
      await heldBehindStart('hello')
      expect(acquire.mock.calls.at(-1)![0].permissionMode).toBe(mode)
      await host.handleAdapterEvent(startedEvent())
      await vi.advanceTimersByTimeAsync(50)
      await host.flushStreamedEvents(SESSION)
      expect(store.getRecord(SESSION)?.permissionMode).toBe(mode)
      await store.backfillChatPermissionModes(() => mode === 'ask')
      expect(store.getRecord(SESSION)?.permissionMode).toBe(mode)
    }
  )
})
