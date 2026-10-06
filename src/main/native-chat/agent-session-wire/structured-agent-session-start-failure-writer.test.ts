// A start a queued message waited on can be seen failing twice: by the delivery loop, when the
// adapter settles the start without proving it, and by the exit settlement, when the child's exit
// lands. The loop is the one writer: it records the failure on the message the start was for, and
// on any message handed to that start's child, which took nothing. A start refused before it ran
// leaves the message waiting for its next try while later ones go on, and after the last try it is
// rejected; a start that ran and failed rejects it at once.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  agentSessionFailureFact,
  type SubmissionRejectionFact
} from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import type {
  AgentJournalMessageItem,
  AgentJournalSubmission
} from '../../../shared/agent-session-journal-types'
import type { AgentSessionSubscribeEvent } from '../../../shared/agent-session-wire'
import { isStructuredAgentSessionStartFailureRow } from '../../../shared/structured-agent-session-start-failure-row-key'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import {
  AgentSessionPreSpawnError,
  type StructuredAgentSessionAdapter
} from './structured-agent-session-adapter'
import {
  structuredAgentSessionCommandTurn,
  structuredAgentSessionCompactBody
} from './structured-agent-session-command-turn'
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
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import { createStructuredAgentSessionLogger } from './structured-agent-session-logger'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'

const CALLER = { callerKey: 'client-1' }
const EXIT_REASON = 'Claude Code is not signed in. Sign in with the Claude CLI'
// A start refused before it ran that may land later without the person: an account switch still
// settling.
const TRANSIENT = agentSessionFailureFact('accountSwitchInProgress')
const TRANSIENT_WORDS = agentSessionFailureWords(TRANSIENT, {
  surface: 'rejection',
  agentName: 'Codex'
})
// Orca tries it again on its own, so the waiting message leaves out trying again.
const WAITING_REASON = 'A Claude account switch is in progress.'
// A start that faulted at a dispatch: no exit was observed, so nothing blames the provider.
const DISPATCH_FAULT = agentSessionFailureFact('startFailed')
const DISPATCH_WORDS = agentSessionFailureWords(DISPATCH_FAULT, {
  surface: 'rejection',
  agentName: 'Codex'
})
const DISPATCH_ERROR = `no live claude stream-json session for ${SESSION}`
// A child that ran and could not finish its start.
const PROVIDER_START_FAILED = agentSessionFailureFact('providerStartFailed')

function eventually(assertion: () => void | Promise<void>): Promise<void> {
  return vi.waitFor(assertion, { timeout: 10_000 })
}

let root: string
let store: AgentSessionRecordStore
let host: StructuredAgentSessionHost
let generation = 0
let clock = NOW
// The wall clock moves on between two reads: the read after this one sees this time.
let advanceAfterRead: number | null = null
let timers: { dueAt: number; run: () => void; cancelled: boolean }[] = []
let settleStart: (failure: SubmissionRejectionFact | undefined) => void = () => {}
// Runs before each spawn; throwing refuses that start before it ran.
let beforeSpawn = vi.fn<() => Promise<void>>()
let awaitStarted = vi.fn<() => Promise<SubmissionRejectionFact | undefined>>()
let dispatch = vi.fn<StructuredAgentSessionAdapter['dispatch']>()
let compact = vi.fn<NonNullable<StructuredAgentSessionAdapter['compact']>>()
let closeSession = vi.fn<NonNullable<StructuredAgentSessionAdapter['closeSession']>>()
let frames: AgentSessionSubscribeEvent[] = []

function exitBeforeProof(): Promise<void> {
  return host.handleAdapterEvent({
    type: 'ended',
    sessionId: SESSION,
    fence: store.getRecord(SESSION)?.lease.runtimeFence ?? 0,
    acquisitionGeneration: `generation-${generation}`,
    reason: EXIT_REASON,
    cause: 'unexpected-exit',
    startupUnproven: true
  })
}

function startHost(): void {
  host = new StructuredAgentSessionHost({
    logger: createStructuredAgentSessionLogger(),
    store,
    adapter: {
      acquire: vi.fn(async ({ fence, spawnToken }) => {
        await beforeSpawn()
        return {
          process: {
            hostId: 'local',
            pid: 4242,
            processStartTimeMs: 1_700_000_000_000,
            spawnToken
          },
          link: {
            linkId: `link-${fence}`,
            handle: codexProviderHandle(THREAD),
            origin: generation === 0 ? ('created' as const) : ('resumed' as const),
            mintedAtFence: fence,
            observedAt: NOW
          },
          acquisitionGeneration: `generation-${++generation}`,
          providerChildPhase: 'starting' as const
        }
      }),
      awaitStarted,
      releaseAcquisition: vi.fn(async () => true),
      closeSession,
      dispatch,
      compact,
      cancelTurn: vi.fn(async () => ({ cancelled: true })),
      answerPrompt: vi.fn(async () => undefined),
      setOption: vi.fn(async () => undefined)
    },
    journalDatabase: openTestJournalHostDatabase(root),
    claimKeyId: 'key-1',
    mintSpawnToken: () => `spawn-${generation + 1}`,
    now: () => {
      const read = clock
      if (advanceAfterRead !== null) {
        clock = advanceAfterRead
        advanceAfterRead = null
      }
      return read
    },
    setStartRetryTimer: (delayMs, run) => {
      const timer = { dueAt: clock + delayMs, run, cancelled: false }
      timers.push(timer)
      return () => {
        timer.cancelled = true
      }
    }
  })
}

function accountSwitchRefusal(): AgentSessionPreSpawnError {
  return new AgentSessionPreSpawnError(new Error('account switch in progress'), {
    reason: 'accountSwitchInProgress'
  })
}

/** Refuses every start from now on before it runs. */
function refuseStarts(): void {
  beforeSpawn.mockImplementation(async () => {
    throw accountSwitchRefusal()
  })
}

/** Refuses the next start before it runs, once the returned call says so. */
function holdNextStart(): () => void {
  let refuse = (): void => {}
  beforeSpawn.mockImplementationOnce(
    () => new Promise<void>((_resolve, reject) => (refuse = () => reject(accountSwitchRefusal())))
  )
  return () => refuse()
}

/** Sent while its own start is held, to be refused before it ran. */
async function sendRefused(text: string): Promise<{ id: string; refuse: () => void }> {
  const refuse = holdNextStart()
  const calls = beforeSpawn.mock.calls.length
  const id = await send(hostTestMessage(text))
  await eventually(() => expect(beforeSpawn.mock.calls.length).toBeGreaterThan(calls))
  return { id, refuse }
}

/** Moves the clock to the booked retry and lets it fire, as its timer would. */
async function fireRetry(): Promise<void> {
  await eventually(() => expect(timers.some((entry) => !entry.cancelled)).toBe(true))
  const timer = timers.findLast((entry) => !entry.cancelled)
  if (!timer) {
    throw new Error('no retry is booked')
  }
  timer.cancelled = true
  clock = timer.dueAt
  timer.run()
}

async function send(body: AgentJournalMessageItem): Promise<string> {
  const sent = await host.send(CALLER, {
    envelope: {
      sessionId: SESSION,
      clientOperationId: hostTestOperationId(),
      expectedRuntimeFence: store.getRecord(SESSION)?.lease.runtimeFence ?? 0,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.send',
        sessionId: SESSION,
        fields: { body }
      })
    },
    body
  })
  expect(sent).toMatchObject({ ok: true })
  return sent.ok ? sent.value.clientMessageId : ''
}

/** Sent while the loop waits on a start it made for the first message. */
async function sendQueued(text: string): Promise<string> {
  const id = await send(hostTestMessage(text))
  await eventually(() => expect(awaitStarted).toHaveBeenCalled())
  return id
}

async function submission(clientMessageId: string): Promise<AgentJournalSubmission | undefined> {
  return (await host.journalSnapshot(SESSION)).submissions.find(
    (entry) => entry.clientMessageId === clientMessageId
  )
}

async function startRows(): Promise<string[]> {
  return (await host.journalSnapshot(SESSION)).items.flatMap((item) =>
    isStructuredAgentSessionStartFailureRow(item.itemId) ? [item.itemId] : []
  )
}

/** Every Stop event the journal holds, oldest first. */
function stopEvents(): unknown[] {
  const journal = host.collaboratorsForTests().sessions.get(SESSION)?.journal
  if (!journal) {
    throw new Error('expected the conversation open')
  }
  const since = journal.readSince({ epoch: journal.epoch, sequence: 0 })
  if (!since.ok) {
    throw new Error(`expected rows, got reset ${since.reset}`)
  }
  return since.rows.flatMap((row) =>
    row.kind === 'tombstone' && row.stopEvent ? [row.stopEvent] : []
  )
}

/** Every failed start a subscriber was told for one message, in order. */
function framedStartFailures(clientMessageId: string): unknown[] {
  return frames.flatMap((frame) =>
    frame.type === 'batch'
      ? frame.batch.submissions.flatMap((entry) =>
          entry.clientMessageId === clientMessageId && entry.startRetry ? [entry.startRetry] : []
        )
      : []
  )
}

/** Every dispatch state a subscriber was told for one message, in order. */
function framedStates(clientMessageId: string): string[] {
  return frames.flatMap((frame) =>
    frame.type === 'batch'
      ? frame.batch.submissions
          .filter((entry) => entry.clientMessageId === clientMessageId)
          .map((entry) => entry.dispatchState)
      : []
  )
}

async function restartHostAndOpen(): Promise<void> {
  await host.flushAllStreamedEvents()
  startHost()
  await host.journalSnapshot(SESSION)
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-start-failure-writer-'))
  resetHostTestOperationIds()
  generation = 0
  clock = NOW
  advanceAfterRead = null
  timers = []
  frames = []
  beforeSpawn = vi.fn(async () => undefined)
  awaitStarted = vi.fn(
    () => new Promise<SubmissionRejectionFact | undefined>((resolve) => (settleStart = resolve))
  )
  dispatch = vi.fn(async () => ({ state: 'admitted' as const }))
  compact = vi.fn(async () => ({ state: 'admitted' as const }))
  closeSession = vi.fn(async () => true)
  store = await openTestAgentSessionRecordStore(root)
  startHost()
  await expect(host.attach(CALLER, hostTestAttachParams(null))).resolves.toMatchObject({
    ok: true
  })
  // The first child (generation-1) is lost at setup; the first send starts generation-2.
  await exitBeforeProof()
  await host.subscribe({ id: 'pane', sessionId: SESSION, emit: (event) => frames.push(event) })
})

afterEach(async () => {
  await host.flushAllStreamedEvents()
  await rm(root, { recursive: true, force: true })
})

describe('a queued message whose start fails', () => {
  it('waits for its next try with the failure on it, and writes no row of its own', async () => {
    const { id: queued, refuse } = await sendRefused('hello')

    refuse()
    await eventually(async () =>
      expect(await submission(queued)).toMatchObject({
        dispatchState: 'pending',
        startRetry: {
          attempts: 1,
          reason: WAITING_REASON,
          rejection: TRANSIENT,
          nextAttemptAt: NOW + 15_000
        }
      })
    )
    expect((await submission(queued))?.handedOverAt).toBeUndefined()
    expect(await startRows()).toEqual([])
    expect(awaitStarted).not.toHaveBeenCalled()
  })

  // Only the start step's own refusal books a try: a situation that could clear on its own, seen
  // after the child was spawned, still ends the message at once.
  it('is rejected at once for any failure after its child was spawned, whatever the failure', async () => {
    const queued = await sendQueued('hello')

    settleStart(TRANSIENT)

    await eventually(async () =>
      expect(await submission(queued)).toMatchObject({
        dispatchState: 'rejected',
        ...TRANSIENT_WORDS
      })
    )
    expect((await submission(queued))?.startRetry).toBeUndefined()
    expect(timers.filter((timer) => !timer.cancelled)).toEqual([])
  })

  it('ends a failed child still there when the next message comes, and starts afresh', async () => {
    const failed = await sendQueued('first')
    settleStart(PROVIDER_START_FAILED)
    await eventually(async () =>
      expect(await submission(failed)).toMatchObject({ dispatchState: 'rejected' })
    )
    // The adapter ends a start it settled unproven; the loop waits for that end.
    expect(closeSession).not.toHaveBeenCalled()
    awaitStarted.mockImplementation(async () => undefined)

    const next = await send(hostTestMessage('second'))

    await eventually(() =>
      expect(dispatch.mock.calls.map(([input]) => input.clientMessageId)).toEqual([next])
    )
    expect(closeSession).toHaveBeenCalledOnce()
    expect(generation).toBe(3)
  })

  it('is tried again at 15 s, 1 min and 5 min, then rejected with the last failure', async () => {
    refuseStarts()
    const queued = await send(hostTestMessage('hello'))

    const booked: number[] = []
    for (const expected of [NOW + 15_000, NOW + 75_000, NOW + 375_000]) {
      await eventually(async () =>
        expect((await submission(queued))?.startRetry?.nextAttemptAt).toBe(expected)
      )
      booked.push(expected)
      await fireRetry()
    }

    await eventually(async () =>
      expect(await submission(queued)).toMatchObject({
        dispatchState: 'rejected',
        ...TRANSIENT_WORDS
      })
    )
    expect((await submission(queued))?.startRetry).toBeUndefined()
    expect(booked).toEqual([NOW + 15_000, NOW + 75_000, NOW + 375_000])
    // One at setup, then one start per try.
    expect(beforeSpawn).toHaveBeenCalledTimes(5)
    expect(dispatch).not.toHaveBeenCalled()
  })

  it.each([
    ['signed out', agentSessionFailureFact('notSignedIn')],
    ['a launch setting to fix', agentSessionFailureFact('managedAccountEnvOverride')],
    [
      'a host that cannot run the chat',
      agentSessionFailureFact('restartFailed', {
        refusal: {
          code: 'structured_agent_session_unsupported',
          details: { reason: 'hostUnsupported' }
        }
      })
    ]
  ])('is rejected at once, with no try booked, when %s', async (_situation, failure) => {
    awaitStarted.mockImplementation(async () => failure)
    const queued = await send(hostTestMessage('hello'))

    await eventually(async () =>
      expect(await submission(queued)).toMatchObject({
        dispatchState: 'rejected',
        ...agentSessionFailureWords(failure, { surface: 'rejection', agentName: 'Codex' })
      })
    )
    expect(framedStartFailures(queued)).toEqual([])
    expect(timers.filter((timer) => !timer.cancelled)).toEqual([])
  })

  it('is rejected at once when its own words send the person to a new chat', async () => {
    const historyTooLarge = agentSessionFailureFact('historyTooLarge')
    awaitStarted.mockImplementation(async () => historyTooLarge)
    const queued = await send(hostTestMessage('hello'))

    await eventually(async () =>
      expect(await submission(queued)).toMatchObject({
        dispatchState: 'rejected',
        rejection: historyTooLarge
      })
    )
    expect(timers.filter((timer) => !timer.cancelled)).toEqual([])
  })

  it('lets a later message go first while it waits, then goes itself when its try is due', async () => {
    const { id: first, refuse } = await sendRefused('first')
    refuse()
    await eventually(async () => expect((await submission(first))?.startRetry).toBeDefined())
    awaitStarted.mockImplementation(async () => undefined)

    const second = await send(hostTestMessage('second'))
    await eventually(() =>
      expect(dispatch.mock.calls.map(([input]) => input.clientMessageId)).toEqual([second])
    )
    expect(await submission(first)).toMatchObject({
      dispatchState: 'pending',
      startRetry: { attempts: 1 }
    })
    expect((await submission(first))?.handedOverAt).toBeUndefined()

    await fireRetry()
    await eventually(() =>
      expect(dispatch.mock.calls.map(([input]) => input.clientMessageId)).toEqual([second, first])
    )
    expect((await submission(first))?.startRetry).toBeUndefined()
  })
})

/** Lets every serialized step a fired wake queued run to its end. */
async function settleSteps(): Promise<void> {
  const { serialize } = host.collaboratorsForTests()
  for (let step = 0; step < 3; step += 1) {
    await serialize(SESSION, async () => undefined)
  }
}

const armed = (): typeof timers => timers.filter((timer) => !timer.cancelled)

describe('the wake for a message waiting out a refused start', () => {
  it('books nothing for a try that comes due while a /compact runs: its end wakes the loop', async () => {
    const { id: first, refuse } = await sendRefused('first')
    refuse()
    await eventually(async () => expect((await submission(first))?.startRetry).toBeDefined())
    awaitStarted.mockImplementation(async () => undefined)
    await send(structuredAgentSessionCompactBody())
    await eventually(() => expect(compact).toHaveBeenCalledOnce())

    await fireRetry()
    await settleSteps()

    expect(armed()).toEqual([])
    expect(dispatch).not.toHaveBeenCalled()
  })

  // A timer can fire a moment before the clock reaches its due time, which the clock then reaches
  // during the step it woke.
  it('is booked again when its try comes due during the step that found it not yet due', async () => {
    const { id: first, refuse } = await sendRefused('first')
    refuse()
    await eventually(async () => expect((await submission(first))?.startRetry).toBeDefined())
    awaitStarted.mockImplementation(async () => undefined)
    await settleSteps()
    const due = (await submission(first))!.startRetry!.nextAttemptAt
    const timer = armed().at(-1)!
    expect(timer.dueAt).toBe(due)

    timer.cancelled = true
    clock = due - 1
    advanceAfterRead = due
    timer.run()
    await settleSteps()

    expect(clock).toBe(due)
    expect(armed()).toHaveLength(1)
    await fireRetry()
    await eventually(() =>
      expect(dispatch.mock.calls.map(([input]) => input.clientMessageId)).toEqual([first])
    )
  })

  it('is not booked again for every commit while nothing can go', async () => {
    const { id: first, refuse } = await sendRefused('first')
    refuse()
    await eventually(async () => expect((await submission(first))?.startRetry).toBeDefined())
    awaitStarted.mockImplementation(async () => undefined)
    const second = await send(hostTestMessage('second'))
    await eventually(() =>
      expect(dispatch.mock.calls.map(([input]) => input.clientMessageId)).toEqual([second])
    )
    await settleSteps()
    const booked = timers.length
    const journal = host.collaboratorsForTests().sessions.get(SESSION)!.journal
    const fence = store.getRecord(SESSION)?.lease.runtimeFence ?? 0

    for (let chunk = 0; chunk < 10; chunk += 1) {
      await journal.appendItem(
        { provider: 'orca', clientMessageId: `chunk-${chunk}` },
        { kind: 'status', text: `chunk ${chunk}` },
        { fence, turnScope: { kind: 'thread' } }
      )
      await settleSteps()
    }

    expect(timers.length).toBe(booked)
    expect(armed()).toHaveLength(1)
  })
})

describe('an operation that needs the agent the chat does not have running', () => {
  function changeGoal() {
    const change = { kind: 'set', objective: 'Ship the parser' } as const
    return host.changeThreadGoal(CALLER, {
      envelope: {
        sessionId: SESSION,
        clientOperationId: hostTestOperationId(),
        expectedRuntimeFence: store.getRecord(SESSION)?.lease.runtimeFence ?? 0,
        payloadFingerprint: computeAgentSessionPayloadFingerprint({
          method: 'agentSession.threadGoal',
          sessionId: SESSION,
          fields: { change }
        })
      },
      change
    })
  }
  const changeThreadGoal = vi.fn(async () => ({ ok: true as const }))
  beforeEach(() => {
    changeThreadGoal.mockClear()
    Object.assign(host.deps.adapter, { changeThreadGoal, supportsThreadGoal: () => true })
  })

  // A start that never settles must not hold the chat: a Stop or the idle sweep has to reach it.
  it("waits for the start it caused outside the chat's queue, then goes ahead", async () => {
    const changed = changeGoal()
    await eventually(() => expect(awaitStarted).toHaveBeenCalled())

    let queueFree = false
    void host.collaboratorsForTests().serialize(SESSION, async () => {
      queueFree = true
    })
    await eventually(() => expect(queueFree).toBe(true))
    expect(changeThreadGoal).not.toHaveBeenCalled()

    // Once settled, the adapter answers at once for that child.
    awaitStarted.mockImplementation(async () => undefined)
    settleStart(undefined)
    await expect(changed).resolves.toMatchObject({ ok: true, value: { change: 'set' } })
    expect(changeThreadGoal).toHaveBeenCalledOnce()
  })

  // Each child that replaced the one waited on is a new start, waited on outside the queue too.
  it('waits outside the queue for every child that replaced the one it waited on', async () => {
    const changed = changeGoal()
    for (const child of ['generation-2', 'generation-3', 'generation-4']) {
      await eventually(() => expect(generation).toBe(Number(child.split('-')[1])))
      let queueFree = false
      void host.collaboratorsForTests().serialize(SESSION, async () => {
        queueFree = true
      })
      await eventually(() => expect(queueFree).toBe(true))
      if (child === 'generation-4') {
        break
      }
      // That child's start lands and it ends before the call is back in the queue.
      const settle = settleStart
      await exitBeforeProof()
      settle(undefined)
    }
    expect(changeThreadGoal).not.toHaveBeenCalled()

    awaitStarted.mockImplementation(async () => undefined)
    settleStart(undefined)
    await expect(changed).resolves.toMatchObject({ ok: true, value: { change: 'set' } })
    expect(changeThreadGoal).toHaveBeenCalledOnce()
  })

  it('is answered with why the start it waited on failed', async () => {
    const changed = changeGoal()
    await eventually(() => expect(awaitStarted).toHaveBeenCalled())

    settleStart(agentSessionFailureFact('notSignedIn'))
    await expect(changed).resolves.toMatchObject({
      ok: false,
      refusal: { code: 'agent_session_operation_invalid', details: { reason: 'notSignedIn' } }
    })
    expect(changeThreadGoal).not.toHaveBeenCalled()
  })
})

describe('a start that fails while its child exits', () => {
  it('is recorded once when the exit lands before the loop sees the start fail', async () => {
    const queued = await sendQueued('hello')

    await exitBeforeProof()
    expect(await submission(queued)).toMatchObject({ dispatchState: 'pending' })
    expect((await submission(queued))?.startRetry).toBeUndefined()
    settleStart(undefined)
    await eventually(async () =>
      expect(await submission(queued)).toMatchObject({
        dispatchState: 'rejected',
        rejection: PROVIDER_START_FAILED
      })
    )
    const recorded = await submission(queued)
    await host.flushStreamedEvents(SESSION)

    expect(await submission(queued)).toEqual(recorded)
    expect(recorded?.startRetry).toBeUndefined()
    expect(timers.filter((timer) => !timer.cancelled)).toEqual([])
    expect(await startRows()).toEqual([])
  })

  it('is recorded once when the exit lands after the loop recorded it', async () => {
    const queued = await sendQueued('hello')

    settleStart(DISPATCH_FAULT)
    await eventually(async () =>
      expect(await submission(queued)).toMatchObject({
        dispatchState: 'rejected',
        ...DISPATCH_WORDS
      })
    )
    const recorded = await submission(queued)
    await exitBeforeProof()
    await host.flushStreamedEvents(SESSION)

    // The exit's own reason never rewrites the failure the loop recorded.
    expect(await submission(queued)).toEqual(recorded)
    expect(await startRows()).toEqual([])
  })

  it('rejects a message its unproven child was handed with the start, never in doubt', async () => {
    awaitStarted.mockImplementation(async () => undefined)
    const handed = await send(hostTestMessage('hello'))
    await eventually(() => expect(dispatch).toHaveBeenCalledOnce())
    expect(await submission(handed)).toMatchObject({
      dispatchState: 'pending',
      handedOverAt: expect.any(Number)
    })

    await exitBeforeProof()

    await eventually(async () =>
      expect(await submission(handed)).toMatchObject({
        dispatchState: 'rejected',
        rejection: PROVIDER_START_FAILED
      })
    )
    expect((await submission(handed))?.startRetry).toBeUndefined()
    expect(timers.filter((timer) => !timer.cancelled)).toEqual([])
    // Never in doubt on the way: the child it was handed to took nothing.
    expect(framedStates(handed)).not.toContain('unknown')
  })
})

// H2d: the child took one message, then could not take the next, and its exit never lands (Orca
// quit or restarted first). The loop is the only one to see that start fail.
describe('a start whose child took one message and cannot take the next', () => {
  it('ends the child and rejects both with that start, and a restart leaves them so', async () => {
    awaitStarted.mockImplementation(async () => undefined)
    dispatch.mockImplementationOnce(async () => ({ state: 'admitted' as const }))
    dispatch.mockImplementation(() => {
      throw new Error(DISPATCH_ERROR)
    })
    const first = await sendQueued('first')
    const second = await send(hostTestMessage('second'))

    await eventually(async () =>
      expect(await submission(second)).toMatchObject({ dispatchState: 'rejected' })
    )
    expect(dispatch).toHaveBeenCalledTimes(2)
    expect(closeSession).toHaveBeenCalled()
    expect(timers.filter((timer) => !timer.cancelled)).toEqual([])
    // The failure is said once, on the messages: ending that child is no Stop.
    expect(stopEvents()).toEqual([])
    for (const id of [first, second]) {
      expect(await submission(id)).toMatchObject({ dispatchState: 'rejected', ...DISPATCH_WORDS })
      expect((await submission(id))?.startRetry).toBeUndefined()
      // Never in doubt on the way: the child it was handed to took nothing.
      expect(framedStates(id)).not.toContain('unknown')
    }

    await restartHostAndOpen()

    for (const id of [first, second]) {
      expect(await submission(id)).toMatchObject({ dispatchState: 'rejected', ...DISPATCH_WORDS })
    }
  })

  it('rejects a message whose every try fails after its handover at the first, with one start', async () => {
    awaitStarted.mockImplementation(async () => undefined)
    dispatch.mockImplementation(() => {
      throw new Error(DISPATCH_ERROR)
    })

    const queued = await send(hostTestMessage('hello'))

    await eventually(async () =>
      expect(await submission(queued)).toMatchObject({
        dispatchState: 'rejected',
        ...DISPATCH_WORDS
      })
    )
    await host.flushStreamedEvents(SESSION)
    expect((await submission(queued))?.startRetry).toBeUndefined()
    expect(framedStartFailures(queued)).toEqual([])
    expect(stopEvents()).toEqual([])
    expect(timers.filter((timer) => !timer.cancelled)).toEqual([])
    expect(dispatch).toHaveBeenCalledOnce()
    // generation-1 at setup, then this message's one start.
    expect(generation).toBe(2)
  })
})

// Like a goal, a rewind or /clear, a command does not wait out a refused start.
describe('a /compact whose start is refused before it ran', () => {
  it('is rejected at once, with no try booked, and a later message goes ahead', async () => {
    const refuse = holdNextStart()
    const calls = beforeSpawn.mock.calls.length
    const command = await send(structuredAgentSessionCompactBody())
    await eventually(() => expect(beforeSpawn.mock.calls.length).toBeGreaterThan(calls))
    refuse()

    await eventually(async () =>
      expect(await submission(command)).toMatchObject({
        dispatchState: 'rejected',
        rejection: TRANSIENT
      })
    )
    expect((await submission(command))?.startRetry).toBeUndefined()
    expect(timers.filter((timer) => !timer.cancelled)).toEqual([])

    awaitStarted.mockImplementation(async () => undefined)
    const later = await send(hostTestMessage('second'))
    await eventually(() =>
      expect(dispatch.mock.calls.map(([input]) => input.clientMessageId)).toEqual([later])
    )
    expect(compact).not.toHaveBeenCalled()
  })
})

describe('a /compact whose start fails at its handover', () => {
  it('ends its turn and says to run /compact again, from its own body', async () => {
    // An older plain message waits out its own refused start; the /compact goes on past it.
    const { id: plain, refuse } = await sendRefused('first')
    refuse()
    await eventually(async () =>
      expect((await submission(plain))?.startRetry).toMatchObject({ attempts: 1 })
    )
    awaitStarted.mockImplementation(async () => undefined)
    compact.mockImplementation(() => {
      throw new Error(DISPATCH_ERROR)
    })

    const command = await send(structuredAgentSessionCompactBody())

    await eventually(async () =>
      expect(await submission(command)).toMatchObject({ dispatchState: 'rejected' })
    )
    expect(compact).toHaveBeenCalledOnce()
    expect((await submission(command))?.reason).toBe(
      agentSessionFailureWords(DISPATCH_FAULT, {
        surface: 'rejection',
        agentName: 'Codex',
        command: 'compact'
      }).reason
    )
    expect((await submission(plain))?.startRetry?.reason).toBe(WAITING_REASON)
    const turn = (await host.journalSnapshot(SESSION)).items.find(
      (item) => item.itemId === structuredAgentSessionCommandTurn(command).itemId
    )
    expect(turn?.body).toMatchObject({ kind: 'turn', state: 'completed', outcome: 'failure' })
  })
})

describe('a message waiting for its next try when it can wait no longer', () => {
  async function retrying(): Promise<string> {
    const { id: queued, refuse } = await sendRefused('hello')
    refuse()
    await eventually(async () =>
      expect((await submission(queued))?.startRetry).toMatchObject({ attempts: 1 })
    )
    return queued
  }

  // The person ended its wait, so nothing announces it; the chat still reads it as failed.
  it('reads as failed with its own failure when the chat closes, and notifies nothing', async () => {
    const queued = await retrying()
    const completions: unknown[] = []
    host.subscribeTurnCompletions({ id: 'dot', emit: (event) => completions.push(event) })

    await host.close(SESSION, 'user-close')

    await eventually(async () =>
      expect(await submission(queued)).toMatchObject({
        dispatchState: 'rejected',
        reason: TRANSIENT_WORDS.reason,
        rejection: TRANSIENT,
        rejectionCause: 'chatClosed'
      })
    )
    await host.journalSnapshot(SESSION)
    expect(completions).toEqual([])
  })

  it('reads as failed with its own failure when Orca quits and restarts, and notifies nothing', async () => {
    const queued = await retrying()
    await host.flushAllStreamedEvents()
    startHost()
    const completions: unknown[] = []
    host.subscribeTurnCompletions({ id: 'dot', emit: (event) => completions.push(event) })

    await host.journalSnapshot(SESSION)

    await eventually(async () =>
      expect(await submission(queued)).toMatchObject({
        dispatchState: 'rejected',
        reason: TRANSIENT_WORDS.reason,
        // Quitting closes the chat first, which ends the wait.
        rejection: TRANSIENT,
        rejectionCause: 'chatClosed'
      })
    )
    expect(completions).toEqual([])
  })

  it('notifies its failure once when its last try fails for good', async () => {
    const queued = await retrying()
    const completions: unknown[] = []
    host.subscribeTurnCompletions({ id: 'dot', emit: (event) => completions.push(event) })
    refuseStarts()

    for (let attempt = 2; attempt <= 4; attempt += 1) {
      await fireRetry()
      if (attempt < 4) {
        await eventually(async () =>
          expect((await submission(queued))?.startRetry).toMatchObject({ attempts: attempt })
        )
      }
    }

    await eventually(async () => expect((await submission(queued))?.dispatchState).toBe('rejected'))
    expect(await submission(queued)).not.toHaveProperty('rejectionCause')
    await eventually(() =>
      expect(completions).toEqual([
        expect.objectContaining({
          type: 'completion',
          completion: expect.objectContaining({ outcome: 'failure' })
        })
      ])
    )
  })

  it('is withdrawn by a Stop, as any queued message is', async () => {
    const queued = await retrying()

    await host.cancel(CALLER, {
      envelope: {
        sessionId: SESSION,
        clientOperationId: hostTestOperationId(),
        expectedRuntimeFence: null,
        payloadFingerprint: computeAgentSessionPayloadFingerprint({
          method: 'agentSession.cancel',
          sessionId: SESSION,
          fields: {}
        })
      }
    })

    expect(await submission(queued)).toMatchObject({
      dispatchState: 'rejected',
      rejection: { kind: 'cancelled' }
    })
  })
})

describe('what waits on a message whose start failed', () => {
  it('is answered at the first failure: the send waits for nothing more', async () => {
    const { id: queued, refuse } = await sendRefused('hello')
    const handedOver = host.waitForSendSettlement(SESSION, queued, {
      until: 'handed-over',
      budgetMs: 5_000
    })
    const answered = host.waitForSendSettlement(SESSION, queued, { budgetMs: 5_000 })

    refuse()

    for (const settled of [await handedOver, await answered]) {
      expect(settled?.value).toMatchObject({
        submission: { dispatchState: 'pending', startRetry: { attempts: 1 } }
      })
    }
  })

  it('reads as neither failed nor working in any session list while it waits', async () => {
    const statuses: { status: unknown; turnOutcome?: unknown }[] = []
    host.subscribeStatus({
      id: 'list-1',
      emit: (event) => {
        if (event.type === 'status' && event.session.sessionId === SESSION) {
          statuses.push(event.session)
        }
      }
    })
    const { id: queued, refuse } = await sendRefused('hello')

    refuse()
    await eventually(async () =>
      expect((await submission(queued))?.startRetry).toMatchObject({ attempts: 1 })
    )

    await eventually(() => expect(statuses.at(-1)).toMatchObject({ status: 'idle' }))
    expect(statuses.at(-1)).not.toHaveProperty('turnOutcome')
  })
})
