import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { CodexAppServerRequestError } from '../../codex/app-server/codex-app-server-request-error'
import { withProviderRequestTimeout } from '../../provider-process/provider-request-timeout'
import { AgentSessionAcquisitionRefusal } from './structured-agent-session-adapter'
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { DISPATCH_REJECTED_CANCELLED } from '../../../shared/structured-agent-session-dispatch-rejection'
import { NATIVE_CHAT_STOPPED_BEFORE_START_TEXT } from '../../../shared/native-chat-stopped-before-start'
import { projectStructuredAgentSessionMessages } from '../../../shared/structured-agent-session-message-projection'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import type {
  AgentSessionAcquisition,
  StructuredAgentSessionAcquireInput,
  StructuredAgentSessionAdapter
} from './structured-agent-session-adapter'
import {
  claudeAndCodexDeclared,
  NO_STRUCTURED_AGENTS
} from './structured-agent-session-adapter-router-test-support'
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
let supportsGoals = false
const providerStarted = vi.fn()
const recordLiveListing = vi.fn()
const openGates = new Map<string, (model: string) => void>()

async function proveOpen(model = 'default'): Promise<void> {
  const generation = `generation-${acquire.mock.calls.length}`
  await eventually(() => expect(openGates.has(generation)).toBe(true))
  openGates.get(generation)!(model)
  openGates.delete(generation)
}

function acquisition(input: StructuredAgentSessionAcquireInput): AgentSessionAcquisition {
  return {
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

const publishFirst: StructuredAgentSessionAdapter['acquire'] = async (input) => acquisition(input)

async function startHost(): Promise<void> {
  host = new StructuredAgentSessionHost({
    agents: supportsGoals ? claudeAndCodexDeclared() : NO_STRUCTURED_AGENTS,
    logger: createStructuredAgentSessionLogger(),
    store,
    adapter: {
      open: ({ acquisitionGeneration }) =>
        new Promise((resolve) => {
          openGates.set(acquisitionGeneration!, (model) => resolve({ reportedOptions: { model } }))
        }),
      acquire,
      dispatch,
      closeSession,
      releaseAcquisition: vi.fn(async () => true),
      cancelTurn: vi.fn(async () => ({ cancelled: false })),
      answerPrompt: vi.fn(async () => undefined),
      setOption
    },
    modelCatalog: {
      peek: () => null,
      read: vi.fn(async () => ({ origin: 'unknown' as const })),
      recordLiveListing,
      retainedLiveModelIds: vi.fn(async () => []),
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

async function restartWith(next: StructuredAgentSessionAdapter['acquire']): Promise<void> {
  await host.close(SESSION, 'evict')
  await host.flushAllStreamedEvents()
  acquire.mockImplementation(next)
  closeSession.mockClear()
  await startHost()
  acquire.mockClear()
}

beforeEach(async () => {
  vi.useFakeTimers({
    toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval']
  })
  root = await mkdtemp(join(tmpdir(), 'orca-startup-attempt-'))
  resetHostTestOperationIds()
  startupLimits = undefined
  supportsGoals = false
  providerStarted.mockReset()
  recordLiveListing.mockReset()
  openGates.clear()
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
  it('keeps a spawned child unopened until required protocol open proves readiness', async () => {
    await restartWith(publishFirst)
    const id = await heldBehindStart('hello')

    expect(await submission(id)).toMatchObject({ dispatchState: 'pending' })
    expect((await submission(id))?.handedOverAt).toBeUndefined()
    expect(dispatch).not.toHaveBeenCalled()

    await proveOpen()

    await eventually(async () => expect((await submission(id))?.dispatchState).toBe('accepted'))
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  it('hands every message held behind the start over, in order, once', async () => {
    await restartWith(publishFirst)
    const first = await heldBehindStart('first')
    const second = await accept('second')
    await accept('first', first)

    await proveOpen()

    await eventually(async () => expect((await submission(second))?.dispatchState).toBe('accepted'))
    expect(dispatch.mock.calls.map(([input]) => input.clientMessageId)).toEqual([first, second])
  })

  it('tells the model catalog once the start proves itself, never for a child it no longer holds', async () => {
    await restartWith(publishFirst)
    providerStarted.mockClear()
    const id = await heldBehindStart('hello')
    expect(providerStarted).not.toHaveBeenCalled()

    await proveOpen()
    await eventually(async () => expect((await submission(id))?.dispatchState).toBe('accepted'))
    expect(providerStarted).toHaveBeenCalledTimes(1)
    expect(providerStarted.mock.calls[0]?.[0]).toMatchObject({ sessionId: SESSION })
  })
})

describe('a start that ends before it proves itself', () => {
  it.each([false, true])(
    'settles only its own message after startup failure (acquisition refusal: %s)',
    async (refused) => {
      await restartWith(publishFirst)
      const id = await heldBehindStart('hello')
      let later: string | undefined

      const physicalAttempts = refused ? 1 : 5
      for (let attempt = 1; attempt <= physicalAttempts; attempt++) {
        await eventually(() => expect(acquire).toHaveBeenCalledTimes(attempt))
        await eventually(() =>
          expect(host.collaboratorsForTests().sessions.get(SESSION)?.child).toBeTruthy()
        )
        if (attempt === physicalAttempts) {
          later = await accept('a later message')
          if (refused) {
            acquire.mockRejectedValueOnce(
              new AgentSessionAcquisitionRefusal('sign in', 'notSignedIn')
            )
          }
        }
        await host.handleAdapterEvent({
          type: 'ended',
          sessionId: SESSION,
          fence: store.getRecord(SESSION)!.lease.runtimeFence,
          acquisitionGeneration: `generation-${acquire.mock.calls.length}`,
          reason: 'exited with code 1',
          cause: 'unexpected-exit'
        })
      }

      await eventually(async () => expect((await submission(id))?.dispatchState).toBe('rejected'))
      expect(await submission(id)).toMatchObject(
        agentSessionFailureWords(
          agentSessionFailureFact(refused ? 'notSignedIn' : 'providerStartFailed'),
          { agentName: 'Codex', surface: 'rejection' }
        )
      )
      expect((await submission(id))?.handedOverAt).toBeUndefined()
      expect(dispatch).not.toHaveBeenCalled()
      await eventually(() => expect(acquire).toHaveBeenCalledTimes(refused ? 3 : 6))
      await proveOpen()
      await eventually(async () =>
        expect((await submission(later!))?.dispatchState).toBe('accepted')
      )
      expect(dispatch.mock.calls.map(([input]) => input.clientMessageId)).toEqual([later])
      expect(startupAttemptOpen()).toBe(false)
    }
  )

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
    // The taken-back send carries its stopped result, and the accepted Stop its one request row.
    const snapshot = await host.journalSnapshot(SESSION)
    expect(
      projectStructuredAgentSessionMessages(snapshot.items, [], snapshot.submissions)
    ).toMatchObject([
      { role: 'user', blocks: [{ type: 'text', text: 'hello' }] },
      { blocks: [{ type: 'text', text: NATIVE_CHAT_STOPPED_BEFORE_START_TEXT }] },
      { blocks: [{ type: 'text', text: 'Cancellation requested.' }] }
    ])
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

  it('stops a published start that never readies at the ceiling, not before, and fails what it held', async () => {
    startupLimits = { ceilingMs: 400 }
    await restartWith(publishFirst)
    const id = await heldBehindStart('hello')
    await vi.advanceTimersByTimeAsync(200)
    expect(closeSession).not.toHaveBeenCalled()
    expect(startupAttemptOpen()).toBe(true)

    await eventually(async () => expect((await submission(id))?.dispatchState).toBe('rejected'), 50)
    expect(await submission(id)).toMatchObject(HOST_STOPPED)
    expect((await submission(id))?.handedOverAt).toBeUndefined()
    expect(closeSession).toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
    expect(startupAttemptOpen()).toBe(false)
  })

  it('aborts an acquire still in its handshake at the ceiling and fails what it held', async () => {
    startupLimits = { ceilingMs: 50 }
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
    startupLimits = { ceilingMs: 50 }
    await restartWith(publishFirst)
    const id = await heldBehindStart('hello')
    await proveOpen()
    await eventually(async () => expect((await submission(id))?.dispatchState).toBe('accepted'))

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
    await proveOpen('reported')
    await eventually(async () => expect((await submission(id))?.dispatchState).toBe('accepted'))
    await host.handleAdapterEvent({
      type: 'options-reported',
      sessionId: SESSION,
      fence: store.getRecord(SESSION)!.lease.runtimeFence,
      acquisitionGeneration: `generation-${acquire.mock.calls.length}`,
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
    await proveOpen('reported')
    await eventually(async () => expect((await submission(id))?.dispatchState).toBe('accepted'))
    await host.handleAdapterEvent({
      type: 'options-reported',
      sessionId: SESSION,
      fence: store.getRecord(SESSION)!.lease.runtimeFence,
      acquisitionGeneration: `generation-${acquire.mock.calls.length}`,
      reportedOptions: { model: 'from-settings' }
    })
    await host.flushStreamedEvents(SESSION)
    expect(store.getRecord(SESSION)?.options).toEqual({ model: 'picked' })
  })

  it('saves a settings readback that arrives before open proves the start', async () => {
    await restartWith(publishFirst)
    await heldBehindStart('hello')
    const listing = { models: [], configuredDefault: { modelId: 'opus' } }
    const reported = host.handleAdapterEvent({
      type: 'options-reported',
      sessionId: SESSION,
      fence: store.getRecord(SESSION)!.lease.runtimeFence,
      acquisitionGeneration: `generation-${acquire.mock.calls.length}`,
      reportedOptions: { model: 'opus' },
      catalogListing: listing
    })
    await proveOpen()
    await reported

    await eventually(() => expect(recordLiveListing).toHaveBeenCalledWith(SESSION, listing))
  })
})

function startupAttemptOpen(): boolean {
  return host.collaboratorsForTests().runtimeState.startupAttempts.isOpen(SESSION)
}

describe('the attempt an acquire runs under', () => {
  it('is minted by the host with the lease and the pinned launch', async () => {
    await restartWith(publishFirst)
    await heldBehindStart('hello')

    const record = store.getRecord(SESSION)!
    const [input] = acquire.mock.calls.at(-1)!
    expect(input).toMatchObject({
      fence: record.lease.runtimeFence,
      launch: { location: record.location, accountHome: record.accountHome }
    })
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
      await proveOpen()
      await vi.advanceTimersByTimeAsync(50)
      await host.flushStreamedEvents(SESSION)
      expect(store.getRecord(SESSION)?.permissionMode).toBe(mode)
      await store.backfillChatPermissionModes(() => mode === 'ask')
      expect(store.getRecord(SESSION)?.permissionMode).toBe(mode)
    }
  )
})

describe('one logical start across physical attempts', () => {
  beforeEach(() => {
    supportsGoals = true
  })
  async function endAttempt() {
    const session = host.collaboratorsForTests().sessions.get(SESSION)!
    const child = session.child!
    if (child.generation === null) {
      throw new Error('expected a published child generation')
    }
    const event = {
      type: 'ended' as const,
      sessionId: SESSION,
      fence: child.fence,
      acquisitionGeneration: child.generation,
      reason: 'exited while starting',
      cause: 'unexpected-exit' as const
    }
    await host.handleAdapterEvent(event)
    await eventually(() => expect(session.child).toBeNull())
    return event
  }

  function goal() {
    const change = { kind: 'set' as const, objective: 'finish startup' }
    return host.changeThreadGoal(CALLER, {
      envelope: {
        sessionId: SESSION,
        clientOperationId: hostTestOperationId(),
        expectedRuntimeFence: null,
        payloadFingerprint: computeAgentSessionPayloadFingerprint({
          method: 'agentSession.threadGoal',
          sessionId: SESSION,
          fields: { change }
        })
      },
      change
    })
  }

  it('holds both sends and a joining operation across retry without status or transcript churn', async () => {
    await restartWith(publishFirst)
    const phases: (string | undefined)[] = []
    host.subscribeStatus({
      id: 'retry-observer',
      emit: (event) => {
        if (event.type === 'status') {
          phases.push(event.session.hostExecutionPhase)
        }
      }
    })
    const ran = vi.fn<NonNullable<StructuredAgentSessionAdapter['changeThreadGoal']>>(async () => ({
      ok: true as const
    }))
    host.deps.adapter.changeThreadGoal = ran
    const artifacts: unknown[] = []
    await host.subscribe({
      id: 'retry-transcript',
      sessionId: SESSION,
      emit: (frame) => {
        if (frame.type === 'batch') {
          artifacts.push(...frame.batch.items.filter((item) => item.body.kind === 'status'))
        }
      }
    })
    const first = await heldBehindStart('first')
    phases.length = 0
    const operation = goal()
    const stale = await endAttempt()
    const second = await accept('second')
    expect(await submission(first)).toMatchObject({ dispatchState: 'pending' })
    expect((await host.readStatusSummary(SESSION))?.hostExecutionPhase).toBe('starting')
    const reconnect: (string | undefined)[] = []
    host.subscribeStatus({
      id: 'during-backoff',
      emit: (event) => {
        if (event.type === 'snapshot') {
          reconnect.push(...event.sessions.map((row) => row.hostExecutionPhase))
        }
      }
    })
    expect(reconnect).toContain('starting')
    const during = await host.journalSnapshot(SESSION)
    expect(during.items.filter((item) => item.body.kind === 'status')).toEqual([])
    expect(
      host.collaboratorsForTests().sessions.get(SESSION)?.journal.stopMarks.latest()
    ).toBeNull()
    await eventually(() => expect(acquire).toHaveBeenCalledTimes(2))
    await proveOpen()
    await host.handleAdapterEvent(stale)
    await eventually(async () => expect((await submission(second))?.dispatchState).toBe('accepted'))
    expect(dispatch.mock.calls.map(([input]) => input.clientMessageId)).toEqual([first, second])
    expect(phases.filter((phase) => phase !== 'starting' && phase !== 'ready')).toEqual([])
    expect(artifacts).toEqual([])
    expect((await host.readStatusSummary(SESSION))?.hostExecutionPhase).toBe('ready')
    expect(await operation).toMatchObject({ ok: true })
    expect(ran).toHaveBeenCalledTimes(1)
    expect(ran.mock.calls[0]?.[0]).toMatchObject({
      fence: host.collaboratorsForTests().sessions.get(SESSION)?.child?.fence
    })
    expect(acquire).toHaveBeenCalledTimes(2)
  })

  it('keeps a typed refusal or an unproven close final without respawning', async () => {
    await restartWith(async () => {
      throw new AgentSessionAcquisitionRefusal('sign in', 'notSignedIn')
    })
    const first = await accept('needs login')
    await eventually(async () => expect((await submission(first))?.dispatchState).toBe('rejected'))
    expect(acquire).toHaveBeenCalledTimes(1)
    acquire.mockClear()
    await restartWith(publishFirst)
    closeSession.mockResolvedValue(false)
    const second = await heldBehindStart('unproven process')
    const child = host.collaboratorsForTests().sessions.get(SESSION)!.child!
    const { lifetime } = host.collaboratorsForTests()
    await expect(
      lifetime.failStartingChild(
        SESSION,
        child,
        new CodexAppServerRequestError('thread/start', -1, 'refused'),
        1
      )
    ).rejects.toThrow('eviction failed')
    await eventually(async () => expect((await submission(second))?.dispatchState).toBe('rejected'))
    expect(host.collaboratorsForTests().sessions.get(SESSION)?.child).toBe(child)
    expect(acquire).toHaveBeenCalledTimes(1)
    closeSession.mockResolvedValue(true)
  })

  it('keeps a starting child journal sink fault final for its requester without respawning', async () => {
    await restartWith(publishFirst)
    const first = await heldBehindStart('journal fails while starting')
    const { sessions, runtimeState } = host.collaboratorsForTests()
    const session = sessions.get(SESSION)!
    const sink = runtimeState.currentEventSink(SESSION)!
    const writes = vi.spyOn(session.journal, 'appendLifecycleBatch')
    vi.spyOn(session.journal, 'appendItem').mockRejectedValueOnce(new Error('journal unavailable'))
    sink.sink.appendItem(
      { provider: 'codex', threadId: THREAD, turnId: 'turn-starting', ordinal: 1 },
      { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'starting' }] },
      { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    await eventually(async () => expect((await submission(first))?.dispatchState).toBe('rejected'))
    expect(session.lastEndedChild).toMatchObject({
      cause: 'exit',
      duringStartup: true,
      rootGone: true,
      failure: { kind: 'hostFault' }
    })
    const failures = writes.mock.calls.filter(([input]) =>
      input.settlementId.startsWith('start-failure:')
    )
    expect(failures).toHaveLength(1)
    expect(failures[0]![0].dispatches).toEqual([
      expect.objectContaining({
        clientMessageId: first,
        state: 'rejected',
        rejection: { kind: 'hostFault' }
      })
    ])
    const snapshot = await host.journalSnapshot(SESSION)
    expect(snapshot.items.filter((item) => item.body.kind === 'status')).toEqual([
      expect.objectContaining({ body: expect.objectContaining({ failure: { kind: 'hostFault' } }) })
    ])
    expect(closeSession).toHaveBeenCalledTimes(1)
    expect(acquire).toHaveBeenCalledTimes(1)
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('ends a backoff on Stop and keeps the original ceiling across attempts', async () => {
    startupLimits = { ceilingMs: 1000 }
    await restartWith(publishFirst)
    const first = await heldBehindStart('stop in backoff')
    await endAttempt()
    expect(await stop()).toMatchObject({ ok: true })
    await vi.advanceTimersByTimeAsync(500)
    expect(acquire).toHaveBeenCalledTimes(1)
    expect((await host.readStatusSummary(SESSION))?.hostExecutionPhase).toBeUndefined()
    expect(await submission(first)).toMatchObject({ dispatchState: 'rejected' })
    acquire.mockClear()
    const second = await heldBehindStart('one clock')
    await vi.advanceTimersByTimeAsync(400)
    await endAttempt()
    await eventually(() => expect(acquire).toHaveBeenCalledTimes(2))
    await vi.advanceTimersByTimeAsync(500)
    await eventually(
      async () => expect((await submission(second))?.dispatchState).toBe('rejected'),
      50
    )
    expect(acquire).toHaveBeenCalledTimes(2)
    expect(await submission(second)).toMatchObject(HOST_STOPPED)
  })

  it('keeps an elapsed provider-step deadline final and preserves its words', async () => {
    await restartWith(publishFirst)
    const first = await heldBehindStart('initialize deadline')
    const { sessions, lifetime } = host.collaboratorsForTests()
    const requestTimeout = { method: 'initialize', timeoutMs: 60_000 }
    await vi.advanceTimersByTimeAsync(60_000)
    await lifetime.failStartingChild(
      SESSION,
      sessions.get(SESSION)!.child!,
      withProviderRequestTimeout(
        new CodexAppServerRequestError('initialize', -1, 'deadline'),
        requestTimeout
      ),
      60_000
    )
    await eventually(async () => expect((await submission(first))?.dispatchState).toBe('rejected'))
    expect(await submission(first)).toMatchObject(
      agentSessionFailureWords(agentSessionFailureFact('startFailed', { requestTimeout }), {
        agentName: 'Codex',
        surface: 'rejection'
      })
    )
    expect(acquire).toHaveBeenCalledTimes(1)
  })

  it('delivers a later message after a delivery step throws', async () => {
    await restartWith(publishFirst)
    const first = await heldBehindStart('failed preparation')
    vi.spyOn(
      host.collaboratorsForTests().runtimeState.deliveryOrder,
      'beforeSend'
    ).mockImplementationOnce(() => {
      throw new Error('delivery preparation failed')
    })
    await proveOpen()
    await eventually(async () => expect((await submission(first))?.dispatchState).toBe('rejected'))
    const later = await accept('after preparation failed')
    await eventually(async () => expect((await submission(later))?.dispatchState).toBe('accepted'))
    expect(dispatch.mock.calls.map(([input]) => input.clientMessageId)).toEqual([later])
  })

  it.each([
    { joins: false, failsWrite: false },
    { joins: true, failsWrite: false },
    { joins: true, failsWrite: true }
  ])(
    'settles an operation start without rejecting a later message (joins: $joins, write fails: $failsWrite)',
    async ({ joins, failsWrite }) => {
      await restartWith(publishFirst)
      host.deps.adapter.changeThreadGoal = vi.fn(async () => ({ ok: true as const }))
      const operation = goal()
      let later: string | undefined
      let restoreWrite: (() => void) | undefined
      for (let number = 1; number <= 5; number++) {
        await eventually(() => expect(acquire).toHaveBeenCalledTimes(number))
        await eventually(() =>
          expect(host.collaboratorsForTests().sessions.get(SESSION)?.child).toBeTruthy()
        )
        if (number === 5 && failsWrite) {
          const journal = host.collaboratorsForTests().sessions.get(SESSION)!.journal
          const append = journal.appendLifecycleBatch.bind(journal)
          const write = vi.spyOn(journal, 'appendLifecycleBatch').mockImplementation((input) => {
            if (input.settlementId.startsWith('start-failure:')) {
              return Promise.reject(new Error('failure write unavailable'))
            }
            return append(input)
          })
          restoreWrite = () => write.mockRestore()
        }
        await endAttempt()
        if (number === 1 && joins) {
          later = await accept('my own start')
        }
      }
      expect(await operation).toMatchObject({ ok: false })
      const snapshot = await host.journalSnapshot(SESSION)
      expect(
        snapshot.items.filter((item) => item.body.kind === 'status' && item.body.tone === 'error')
      ).toHaveLength(failsWrite ? 0 : 1)
      if (later) {
        const expectedMessages = [later]
        expect(await submission(later)).toMatchObject({ dispatchState: 'pending' })
        if (failsWrite) {
          await eventually(() =>
            expect(host.collaboratorsForTests().conversationDelivery.loop.isRunning(SESSION)).toBe(
              false
            )
          )
          expect(await submission(later)).toMatchObject({ dispatchState: 'pending' })
          restoreWrite?.()
          expectedMessages.push(await accept('after the journal recovered'))
        }
        await eventually(() => expect(acquire).toHaveBeenCalledTimes(6))
        await proveOpen()
        await eventually(async () =>
          expect((await submission(later))?.dispatchState).toBe('accepted')
        )
        await eventually(() =>
          expect(dispatch.mock.calls.map(([input]) => input.clientMessageId)).toEqual(
            expectedMessages
          )
        )
      }
    }
  )
})
