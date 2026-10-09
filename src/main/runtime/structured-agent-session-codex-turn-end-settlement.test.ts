// A Codex send the turn it went into never took: the Stop that interrupts that turn
// withdraws it, and nothing reads as working after. A send made while that turn runs, a
// queued card's Send-now included, goes in as `turn/steer` naming it. A Stop made before Codex
// opens that turn interrupts it at once; refused before Codex's thread runs it, the Stop waits
// for it to open and interrupts once more. A send made then waits for it to open.
// Driven through the shipped host, journal and Codex adapter; only the Codex child is fake,
// keeping Codex 0.157's turn bookkeeping.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CodexAppServerRequestError,
  type CodexAppServerConnection,
  type CodexAppServerConnectionHandlers,
  type openCodexAppServerConnection
} from '../codex/codex-app-server-connection'
import { codexTurnLifecycleFake } from '../codex/codex-turn-lifecycle-fake'
import { settledWithin } from '../codex/codex-structured-dispatch-test-support'
import { CODEX_TURN_OPEN_WAIT_MS } from '../codex/codex-structured-turn-open-wait'
import type * as CodexTurnOpenWait from '../codex/codex-structured-turn-open-wait'
import { computeAgentSessionPayloadFingerprint } from '../../shared/agent-session-mutation-envelope'
import type { AgentJournalSubmission } from '../../shared/agent-session-journal-types'
import { classifyDispatchRejection } from '../../shared/structured-agent-session-dispatch-rejection'
import { owesStructuredAgentSessionWork } from '../../shared/structured-agent-session-owed-work'
import { readAgentJournalTurn } from '../../shared/agent-session-turn-record'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import { structuredAgentSessionStopNoteIdentity } from '../native-chat/agent-session-wire/structured-agent-session-command-turn'
import {
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD,
  hostTestAttachParams,
  hostTestMessage
} from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import { CHILD_EVICTION_TIMEOUT_MS } from '../native-chat/agent-session-wire/structured-agent-session-host-teardown'
import {
  ensureStructuredAgentSessionHost,
  stopStructuredAgentSessionRuntime
} from './structured-agent-session-runtime'
import { createStructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'
import { createCoordinatorMailObservationClock } from './structured-chat-coordinator-observation-clock.test-fixture'

// The turns a send or Stop is waiting on to open, so a test knows the wait began.
const openWaits = vi.hoisted(() => {
  const state: {
    turnIds: string[]
    ended: string[]
    began: (() => void) | null
    releaseAll: (() => void) | null
  } = { turnIds: [], ended: [], began: null, releaseAll: null }
  return state
})
vi.mock('../codex/codex-structured-turn-open-wait', async (importOriginal) => {
  const actual = await importOriginal<typeof CodexTurnOpenWait>()
  return {
    ...actual,
    createCodexTurnOpenWaits: () => {
      const waits = actual.createCodexTurnOpenWaits()
      openWaits.releaseAll = waits.releaseAll
      return {
        ...waits,
        wait: (turnId: string, withinMs: number) => {
          openWaits.turnIds.push(turnId)
          const pending = waits.wait(turnId, withinMs)
          openWaits.began?.()
          return pending.then(() => {
            openWaits.ended.push(turnId)
          })
        }
      }
    }
  }
})

const CALLER = { callerKey: 'codex-turn-end-test' }
const MODEL = {
  model: 'gpt-test',
  displayName: 'GPT Test',
  hidden: false,
  supportedReasoningEfforts: [],
  defaultReasoningEffort: null,
  isDefault: true
}

let root: string
let host: StructuredAgentSessionHost
let fence: number
let handlers: CodexAppServerConnectionHandlers | undefined
let answers: number
let steers: number
let interrupts: number
let childCloses: number
let connections: number
/** Closes that fail before one goes through, as a kill that times out. */
let failingCloses: number
/** Codex fails every interrupt it is sent, as one it could not submit (-32603). */
let interruptsFail: boolean
/** Codex takes the interrupt and answers it; the test sends that turn's end later. */
let interruptEndHeld: boolean
let turns: ReturnType<typeof codexTurnLifecycleFake>
let operations = 0

/** The durable ledger stamps its own clock and refuses an id far from it. */
const operationId = (): string => `${Date.now()}-${(++operations).toString(16).padStart(32, '0')}`

function envelope(method: string, fields: Record<string, unknown>) {
  return {
    sessionId: SESSION,
    clientOperationId: operationId(),
    expectedRuntimeFence: fence,
    payloadFingerprint: computeAgentSessionPayloadFingerprint({
      method,
      sessionId: SESSION,
      fields
    })
  }
}

async function send(text: string): Promise<string> {
  const body = hostTestMessage(text)
  const sent = await host.send(CALLER, { envelope: envelope('agentSession.send', { body }), body })
  if (!sent.ok) {
    throw new Error(JSON.stringify(sent.refusal))
  }
  return sent.value.clientMessageId
}

/** A mid-turn send held as a card, then that card's Send-now; resolves with the send it made. */
async function queueThenSendNow(text: string): Promise<{ messageId: string; sent: string }> {
  const body = hostTestMessage(text)
  const delivery = 'queue-if-active' as const
  const queued = await host.send(CALLER, {
    envelope: envelope('agentSession.send', { body, delivery }),
    body,
    delivery
  })
  if (!queued.ok || !('queued' in queued.value)) {
    throw new Error(`expected a queued card: ${JSON.stringify(queued)}`)
  }
  const { messageId } = queued.value.queued
  const sentNow = await host.queuedMessageSend(CALLER, {
    envelope: envelope('agentSession.queuedMessageSend', { messageId }),
    messageId
  })
  if (!sentNow.ok) {
    throw new Error(JSON.stringify(sentNow.refusal))
  }
  return { messageId, sent: sentNow.value.clientMessageId }
}

async function stop(turnId?: string): Promise<void> {
  const stopped = await host.cancel(CALLER, {
    envelope: envelope('agentSession.cancel', turnId === undefined ? {} : { turnId }),
    ...(turnId === undefined ? {} : { turnId })
  })
  if (!stopped.ok) {
    throw new Error(JSON.stringify(stopped.refusal))
  }
}

/** `/compact` as the chat surface runs it; refused while the chat still owes work. */
async function compact() {
  const command = 'compact' as const
  return host.conversationCommand(CALLER, {
    command,
    envelope: envelope('agentSession.conversationCommand', { command })
  })
}

async function settled(): Promise<{
  submissions: readonly AgentJournalSubmission[]
  owesWork: boolean
}> {
  await host.flushStreamedEvents(SESSION)
  const snapshot = await host.journalSnapshot(SESSION)
  return {
    submissions: snapshot.submissions,
    // The shared rule every surface reads "working" from.
    owesWork: owesStructuredAgentSessionWork(snapshot.items, snapshot.submissions, fence)
  }
}

async function statusRows(): Promise<string[]> {
  return (await host.journalSnapshot(SESSION)).items.flatMap((item) =>
    item.body.kind === 'status' ? [item.body.text] : []
  )
}

function verdictOf(submissions: readonly AgentJournalSubmission[], clientMessageId: string) {
  const submission = submissions.find((entry) => entry.clientMessageId === clientMessageId)
  return submission?.dispatchState === 'rejected'
    ? classifyDispatchRejection(submission).category
    : submission?.dispatchState
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-codex-turn-end-'))
  openWaits.turnIds.length = 0
  openWaits.ended.length = 0
  openWaits.began = null
  answers = 0
  steers = 0
  interrupts = 0
  childCloses = 0
  connections = 0
  failingCloses = 0
  interruptsFail = false
  interruptEndHeld = false
  turns = codexTurnLifecycleFake(
    THREAD,
    () => (method, params) => handlers?.onNotification?.(method, params)
  )
  const openConnection: typeof openCodexAppServerConnection = async (
    _launch,
    connectionHandlers = {}
  ) => {
    handlers = connectionHandlers
    connections += 1
    const connection: CodexAppServerConnection = {
      pid: 4321,
      closed: false,
      request: async (method, params) => {
        if (method === 'thread/start' || method === 'thread/resume') {
          return { thread: { id: THREAD } }
        }
        if (method === 'model/list') {
          return { data: [MODEL], nextCursor: null }
        }
        if (method === 'turn/start') {
          answers += 1
          return turns.routes['turn/start']()
        }
        if (method === 'turn/steer') {
          steers += 1
          return turns.routes['turn/steer'](params)
        }
        if (method === 'turn/interrupt' && interruptsFail) {
          interrupts += 1
          throw new CodexAppServerRequestError(
            'turn/interrupt',
            -32603,
            'codex app-server turn/interrupt failed: could not submit',
            'could not submit'
          )
        }
        if (method === 'turn/interrupt' && interruptEndHeld) {
          interrupts += 1
          turns.takeInterrupt()
          return {}
        }
        if (method === 'turn/interrupt') {
          interrupts += 1
          return turns.routes['turn/interrupt'](params)
        }
        return {}
      },
      notify: () => {},
      respond: () => {},
      respondWithError: () => {},
      close: async () => {
        if (failingCloses > 0) {
          failingCloses -= 1
          throw new Error('the kill timed out')
        }
        childCloses += 1
        return true
      }
    }
    return connection
  }
  host = await ensureStructuredAgentSessionHost({
    logger: createStructuredAgentSessionLogger(),
    stateDirectory: root,
    hostId: 'local',
    claimKeyId: 'key-1',
    resolveWorkspacePath: async () => root,
    resolveLaunchArgs: () => [],
    resolveClaudeAuthPolicy: () => ({ stripAuthEnv: true }),
    resolveCodexCommand: () => 'codex',
    resolveEnvironment: async () => ({ PATH: process.env.PATH }),
    openCodexConnection: openConnection,
    readProcessStartTime: async () => 1_700_000_000_000
  })
  const attachParams = hostTestAttachParams(null, { providerHandle: undefined })
  attachParams.envelope.clientOperationId = operationId()
  const attached = await host.attach(CALLER, attachParams)
  if (!attached.ok) {
    throw new Error(JSON.stringify(attached.refusal))
  }
  fence = attached.value.fence
})

afterEach(async () => {
  openWaits.releaseAll?.()
  vi.useRealTimers()
  await stopStructuredAgentSessionRuntime()
  await rm(root, { recursive: true, force: true })
})

describe('a Codex send its turn ended without taking it', () => {
  it('is withdrawn by a Stop before any echo, and nothing reads as working after', async () => {
    const sent = await send('look around')
    await vi.waitFor(() => expect(answers).toBe(1))
    turns.start()

    await stop('turn-1')

    await vi.waitFor(async () =>
      expect(verdictOf((await settled()).submissions, sent)).not.toBe('pending')
    )
    const after = await settled()
    expect(verdictOf(after.submissions, sent)).toBe('withdrawn')
    expect(after.owesWork).toBe(false)

    // Codex echoing it late changes nothing: a settled answer stands.
    await host.settleLateDispatch({
      sessionId: SESSION,
      clientMessageId: sent,
      providerIdentity: { provider: 'codex', threadId: THREAD, turnId: 'turn-1', ordinal: 0 }
    })
    expect(verdictOf((await settled()).submissions, sent)).toBe('withdrawn')
  })

  it('withdraws a follow-up Codex steered into the turn a Stop ends, with no working latch', async () => {
    const opening = await send('look around')
    await vi.waitFor(() => expect(answers).toBe(1))
    turns.start()
    turns.echo(opening)
    const followUp = await send('and check the tests')
    // Steered into the running turn by name, which fires no second turn/started.
    await vi.waitFor(() => expect(steers).toBe(1))
    expect(answers).toBe(1)

    await stop('turn-1')

    await vi.waitFor(async () =>
      expect(verdictOf((await settled()).submissions, followUp)).not.toBe('pending')
    )
    const after = await settled()
    expect(verdictOf(after.submissions, opening)).toBe('accepted')
    expect(verdictOf(after.submissions, followUp)).toBe('withdrawn')
    expect(after.owesWork).toBe(false)
  })
})

describe('the turn a withdrawn Codex send was answered into', () => {
  async function answeredInto(clientMessageId: string) {
    await host.flushStreamedEvents(SESSION)
    const snapshot = await host.journalSnapshot(SESSION)
    const page = await host.history({ sessionId: SESSION, direction: 'tail' })
    const onPage = page.ok
      ? page.page.submissions.find((entry) => entry.clientMessageId === clientMessageId)
      : undefined
    return {
      turnRecords: snapshot.items.flatMap((item) =>
        item.body.kind === 'turn' ? [item.itemId] : []
      ),
      named: snapshot.submissions.find((entry) => entry.clientMessageId === clientMessageId)
        ?.answeredInTurn,
      onPage: onPage?.answeredInTurn
    }
  }

  it("is that turn's record, started by the send that opened it and steered by a later one", async () => {
    const opening = await send('look around')
    await vi.waitFor(() => expect(answers).toBe(1))
    turns.start()
    const steered = await send('and check the tests')
    await vi.waitFor(() => expect(steers).toBe(1))

    await stop('turn-1')
    await vi.waitFor(async () =>
      expect(verdictOf((await settled()).submissions, steered)).toBe('withdrawn')
    )

    const { turnRecords } = await answeredInto(opening)
    expect(turnRecords).toHaveLength(1)
    const started = { turnItemId: turnRecords[0], via: 'start' }
    const steeredIn = { turnItemId: turnRecords[0], via: 'steer' }
    expect(await answeredInto(opening)).toEqual({ turnRecords, named: started, onPage: started })
    expect(await answeredInto(steered)).toEqual({
      turnRecords,
      named: steeredIn,
      onPage: steeredIn
    })
  })

  it('is not named on a send the turn took', async () => {
    const opening = await send('look around')
    await vi.waitFor(() => expect(answers).toBe(1))
    turns.start()
    turns.echo(opening)

    await stop('turn-1')
    await vi.waitFor(async () =>
      expect(verdictOf((await settled()).submissions, opening)).toBe('accepted')
    )

    expect(await answeredInto(opening)).toMatchObject({ named: undefined, onPage: undefined })
  })

  it('is named when the answer is read after that turn ended', async () => {
    const release = turns.holdNextAnswer()
    const sent = await send('look around')
    await vi.waitFor(() => expect(turns.turnId).toBe('turn-1'))
    turns.start()
    turns.end('interrupted')
    release()

    await vi.waitFor(async () =>
      expect(verdictOf((await settled()).submissions, sent)).toBe('withdrawn')
    )
    const { turnRecords, named } = await answeredInto(sent)
    expect(turnRecords).toHaveLength(1)
    expect(named).toEqual({ turnItemId: turnRecords[0], via: 'start' })
  })
})

describe('a queued card sent now into the turn a Stop ends', () => {
  async function handoffs(messageId: string): Promise<AgentJournalSubmission[]> {
    return (await settled()).submissions.filter((entry) => entry.queuedMessageId === messageId)
  }

  /** Each hand-off of the card, as how it settled. */
  async function sends(messageId: string) {
    return (await handoffs(messageId)).map((entry) => ({
      verdict: verdictOf([entry], entry.clientMessageId)
    }))
  }

  async function queue() {
    const page = await host.history({ sessionId: SESSION, direction: 'tail' })
    if (!page.ok) {
      throw new Error('history refused')
    }
    return {
      pause: page.page.queuePause ?? null,
      cards: (page.page.queuedMessages ?? []).map(({ messageId, state }) => ({ messageId, state }))
    }
  }

  it('comes back as a paused waiting card, and nothing sends it again', async () => {
    const opening = await send('look around')
    await vi.waitFor(() => expect(answers).toBe(1))
    turns.start()
    turns.echo(opening)
    const { messageId: cardId } = await queueThenSendNow('and check the tests')
    // Steered into the running turn, with no echo yet.
    await vi.waitFor(() => expect(steers).toBe(1))
    const [steered] = await handoffs(cardId)
    expect(steered?.dispatchState).toBe('pending')

    await stop('turn-1')

    await vi.waitFor(async () => {
      const [withdrawn] = await handoffs(cardId)
      expect(verdictOf([withdrawn!], withdrawn!.clientMessageId)).toBe('withdrawn')
    })
    await vi.waitFor(
      async () =>
        expect({ ...(await queue()), sends: await sends(cardId) }).toEqual({
          pause: { reason: 'stopped' },
          cards: [{ messageId: cardId, state: 'waiting' }],
          sends: [{ verdict: 'withdrawn' }]
        }),
      { timeout: 5_000 }
    )
    // A drain ignoring the pause re-sends only after the stopped turn ends: watch past that.
    await vi.waitFor(() => expect(turns.turnId).toBeNull())
    const clock = createCoordinatorMailObservationClock(() => host, SESSION)
    clock.start()
    try {
      await clock.observe(2_500)
      await host.collaboratorsForTests().serialize(SESSION, async () => {})
    } finally {
      clock.restore()
    }
    expect(steers + answers).toBe(2)
    expect(await sends(cardId)).toEqual([{ verdict: 'withdrawn' }])
  }, 20_000)
})

describe('a Codex before 0.148, which names a steered start falsely', () => {
  it('withdraws a send made while a turn runs when a Stop ends it, and then takes /compact', async () => {
    turns = codexTurnLifecycleFake(
      THREAD,
      () => (method, params) => handlers?.onNotification?.(method, params),
      { legacyStartAnswers: true }
    )
    const opening = await send('look around')
    await vi.waitFor(() => expect(answers).toBe(1))
    turns.start()
    turns.echo(opening)
    const followUp = await send('and check the tests')
    await vi.waitFor(() => expect(steers + answers).toBe(2))

    await stop()

    await vi.waitFor(async () =>
      expect(verdictOf((await settled()).submissions, followUp)).not.toBe('pending')
    )
    const after = await settled()
    expect(verdictOf(after.submissions, followUp)).toBe('withdrawn')
    expect(after.owesWork).toBe(false)
    expect(await compact()).toMatchObject({ ok: true })
    expect(steers).toBe(1)
  })
})

describe("a queued card's Send-now while a Codex turn runs", () => {
  async function runningTurn(): Promise<void> {
    const opening = await send('look around')
    await vi.waitFor(() => expect(answers).toBe(1))
    turns.start()
    turns.echo(opening)
  }

  it('goes into that turn as turn/steer, and the turn settles it when Codex echoes it', async () => {
    await runningTurn()

    const { messageId, sent } = await queueThenSendNow('and check the tests')

    await vi.waitFor(() => expect(steers).toBe(1))
    expect(answers).toBe(1)
    const handedOver = (await settled()).submissions.find((entry) => entry.clientMessageId === sent)
    expect(handedOver).toMatchObject({ queuedMessageId: messageId, dispatchState: 'pending' })
    turns.echo(sent)
    turns.end('completed')

    await vi.waitFor(async () =>
      expect(verdictOf((await settled()).submissions, sent)).toBe('accepted')
    )
    expect((await settled()).owesWork).toBe(false)
  })

  it('is withdrawn when a Stop ends that turn, on a Codex that names a steered start falsely', async () => {
    // Before 0.148, a steered turn/start answers with an id no turn opens or ends under,
    // so only the steer's own answer names the turn whose end settles the send.
    turns = codexTurnLifecycleFake(
      THREAD,
      () => (method, params) => handlers?.onNotification?.(method, params),
      { legacyStartAnswers: true }
    )
    await runningTurn()

    const { sent } = await queueThenSendNow('and check the tests')
    await vi.waitFor(() => expect(steers + answers).toBe(2))

    await stop('turn-1')

    await vi.waitFor(async () =>
      expect(verdictOf((await settled()).submissions, sent)).toBe('withdrawn')
    )
    expect(steers).toBe(1)
  })
})

describe('a second send made after Codex answered the first, before it opened that turn', () => {
  it('joins that turn once it opens, on a Codex that names a steered start falsely, so a Stop withdraws both', async () => {
    turns = codexTurnLifecycleFake(
      THREAD,
      () => (method, params) => handlers?.onNotification?.(method, params),
      { legacyStartAnswers: true }
    )
    const opening = await send('look around')
    await vi.waitFor(() => expect(answers).toBe(1))
    const followUp = await send('and check the tests')
    // Held until that turn opens, so Codex is never asked to steer into a turn it has not started:
    // the delivery loop goes idle with no wait on turn-1, which a handover would have started.
    const { loop } = host.collaboratorsForTests().conversationDelivery
    await vi.waitFor(() => expect(loop.isRunning(SESSION)).toBe(false))
    expect(openWaits.turnIds).toEqual([])
    turns.start()
    await vi.waitFor(() => expect(steers).toBe(1))
    expect(answers).toBe(1)

    await stop()

    await vi.waitFor(async () =>
      expect(verdictOf((await settled()).submissions, followUp)).not.toBe('pending')
    )
    const after = await settled()
    expect(verdictOf(after.submissions, opening)).toBe('withdrawn')
    expect(verdictOf(after.submissions, followUp)).toBe('withdrawn')
    expect(after.owesWork).toBe(false)
  })
})

describe('a Stop sent after Codex answered a cold send, before it opened the turn', () => {
  it('refused before the thread runs it, waits for the turn to open, then stops it and withdraws the send', async () => {
    const sent = await send('look around')
    await vi.waitFor(() => expect(answers).toBe(1))

    await host.flushStreamedEvents(SESSION)
    const began = Promise.withResolvers<void>()
    openWaits.began = began.resolve
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    const stopping = stop()
    await began.promise
    const held = settledWithin(stopping, 1_000)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(openWaits.ended).toEqual([])
    expect(await held).toBe('held')
    expect(interrupts).toBe(1)
    turns.start()
    await stopping

    expect(interrupts).toBe(2)
    await vi.waitFor(() => expect(turns.turnId).toBeNull())
    await vi.waitFor(async () =>
      expect(verdictOf((await settled()).submissions, sent)).toBe('withdrawn')
    )
    expect((await settled()).owesWork).toBe(false)
  })
})

describe('a Stop in that window that the turn never opens for', () => {
  async function waitingStop(): Promise<{ stopping: Promise<void>; sent: string }> {
    const sent = await send('look around')
    await vi.waitFor(() => expect(answers).toBe(1))
    await host.flushStreamedEvents(SESSION)
    const began = Promise.withResolvers<void>()
    openWaits.began = began.resolve
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    const stopping = stop()
    await began.promise
    const held = settledWithin(stopping, 200)
    await vi.advanceTimersByTimeAsync(200)
    expect(await held).toBe('held')
    return { stopping, sent }
  }

  it('reports the refused Stop when its requested turn ends first', async () => {
    const { stopping } = await waitingStop()

    turns.end('interrupted')
    await stopping

    expect(interrupts).toBe(1)
    expect(childCloses).toBe(0)
    expect(await statusRows()).toContain("Codex didn't stop. Check the chat before trying again.")
  })

  it('lets a chat closed behind it close within its bound and one eviction', async () => {
    const { stopping, sent } = await waitingStop()

    const closing = host.close(SESSION, 'evict')
    const closedWithinBound = settledWithin(
      closing,
      CODEX_TURN_OPEN_WAIT_MS + CHILD_EVICTION_TIMEOUT_MS
    )
    await vi.advanceTimersByTimeAsync(CODEX_TURN_OPEN_WAIT_MS - 201)
    expect(openWaits.ended).toEqual([])
    expect(childCloses).toBe(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(openWaits.ended).toEqual(['turn-1'])

    expect(await closedWithinBound).not.toBe('held')
    expect(await settledWithin(stopping, 0)).not.toBe('held')
    expect(childCloses).toBe(1)
    expect(interrupts).toBe(1)
    // Its wait ran out with the turn still able to open, so the Stop ended the child and took the
    // send back.
    expect(verdictOf((await settled()).submissions, sent)).toBe('withdrawn')
  })

  it('lets the app quit behind it within the eviction budget, and still close the child', async () => {
    await waitingStop()

    const quitWithinBound = settledWithin(
      stopStructuredAgentSessionRuntime(),
      CHILD_EVICTION_TIMEOUT_MS
    )
    await vi.advanceTimersByTimeAsync(CODEX_TURN_OPEN_WAIT_MS - 201)
    expect(openWaits.ended).toEqual([])
    expect(childCloses).toBe(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(openWaits.ended).toEqual(['turn-1'])
    expect(await quitWithinBound).not.toBe('held')
    expect(childCloses).toBe(1)
  })
})

describe("a Stop pressed while Codex's turn/start is in flight", () => {
  async function stopWhenItsTurnNeverOpens(release?: () => void): Promise<void> {
    await host.flushStreamedEvents(SESSION)
    const began = Promise.withResolvers<void>()
    openWaits.began = began.resolve
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    const stopping = settledWithin(stop(), CODEX_TURN_OPEN_WAIT_MS + 2_000)
    release?.()
    await began.promise
    await vi.advanceTimersByTimeAsync(CODEX_TURN_OPEN_WAIT_MS - 1)
    expect(openWaits.ended).toEqual([])
    await vi.advanceTimersByTimeAsync(2_001)
    expect(await stopping).not.toBe('held')
  }

  function turnRow(
    items: Awaited<ReturnType<StructuredAgentSessionHost['journalSnapshot']>>['items']
  ) {
    return items
      .map((item) => readAgentJournalTurn(item.body))
      .find((turn) => turn?.turnId === 'turn-1')
  }

  it("interrupts the turn that opens, which reads as the Stop's, and nothing reads as running", async () => {
    const release = turns.holdNextAnswer()
    await send('look around')
    await vi.waitFor(() => expect(answers).toBe(1))
    // Queued behind the send's handover on the session's lane, so it runs after Codex answers.
    const stopping = stop()
    release()
    await vi.waitFor(() => expect(openWaits.turnIds).toContain('turn-1'))
    turns.start()
    await stopping

    // Refused before the thread ran the turn, then taken once it opened.
    expect(interrupts).toBe(2)
    expect(turnRow((await host.journalSnapshot(SESSION)).items)).toMatchObject({
      state: 'interrupted',
      outcome: 'cancellation'
    })
    // Codex's end, after its answer, settles the send.
    await vi.waitFor(async () => expect((await settled()).owesWork).toBe(false))
  })

  // The Stop was read with no turn running; its note is the turn the interrupt took, as a normal
  // Stop's is, never a conversation row below whatever came next.
  it('keeps its note with the turn the interrupt took', async () => {
    const release = turns.holdNextAnswer()
    await send('look around')
    await vi.waitFor(() => expect(answers).toBe(1))
    const stopping = stop()
    release()
    await vi.waitFor(() => expect(openWaits.turnIds).toContain('turn-1'))
    turns.start()
    await stopping

    const { items } = await host.journalSnapshot(SESSION)
    const turn = items.find((item) => readAgentJournalTurn(item.body)?.turnId === 'turn-1')
    expect(readAgentJournalTurn(turn?.body)?.state).toBe('interrupted')
    const notes = items.filter(
      (item) => item.body.kind === 'status' && item.body.text === 'Cancellation requested.'
    )
    expect(notes.map((note) => [note.itemId, note.turnScope])).toEqual([
      [
        agentJournalItemKey(structuredAgentSessionStopNoteIdentity('turn-1')),
        { kind: 'turn', turnItemId: turn?.itemId }
      ]
    ])
  })

  it('ends the child when its interrupt was refused and the turn has not opened by the end of its wait', async () => {
    await stoppedBeforeItsTurnOpened()

    expect(interrupts).toBe(1)
    expect(childCloses).toBe(1)
    expect((await settled()).owesWork).toBe(false)
    expect(turnRow((await host.journalSnapshot(SESSION)).items)).toBeUndefined()
  })

  // Codex records a prompt only once its turn starts, so a send whose turn never opened never ran:
  // the Stop takes it back, and no send in doubt holds the client's queue.
  async function stoppedBeforeItsTurnOpened(): Promise<string> {
    const release = turns.holdNextAnswer()
    const sent = await send('look around')
    await vi.waitFor(() => expect(answers).toBe(1))
    await stopWhenItsTurnNeverOpens(release)
    return sent
  }

  async function nextSendStartsANewChild(): Promise<string> {
    turns = codexTurnLifecycleFake(
      THREAD,
      () => (method, params) => handlers?.onNotification?.(method, params)
    )
    const next = await send('try again')
    await vi.waitFor(() => expect(answers).toBe(2))
    expect(connections).toBe(2)
    return next
  }

  it('withdraws the send whose turn never opened, and the next send starts a new child', async () => {
    const sent = await stoppedBeforeItsTurnOpened()

    expect(childCloses).toBe(1)
    expect(verdictOf((await settled()).submissions, sent)).toBe('withdrawn')
    await nextSendStartsANewChild()
  })

  // Nothing it stopped stays in the transcript, so a Stop row would read as stopping the turn before.
  it('leaves no Stop row under the turn before once it takes the send back', async () => {
    const warmUp = await send('warm up')
    await vi.waitFor(() => expect(answers).toBe(1))
    turns.start()
    turns.echo(warmUp)
    turns.end('completed')
    const release = turns.holdNextAnswer()
    const sent = await send('look around')
    await vi.waitFor(() => expect(answers).toBe(2))
    await stopWhenItsTurnNeverOpens(release)

    expect(verdictOf((await settled()).submissions, sent)).toBe('withdrawn')
    expect(await statusRows()).toEqual([])
    expect(turnRow((await host.journalSnapshot(SESSION)).items)).toMatchObject({
      state: 'completed'
    })
  })

  // Its turn/start answer lost, the send is in doubt rather than pending; the child's end takes it
  // back all the same, so it writes no row either.
  it('leaves no Stop row under the turn before when it takes back a send whose answer was lost', async () => {
    const warmUp = await send('warm up')
    await vi.waitFor(() => expect(answers).toBe(1))
    turns.start()
    turns.echo(warmUp)
    turns.end('completed')
    const answer = turns.routes['turn/start']
    turns.routes['turn/start'] = () => {
      turns.routes['turn/start'] = answer
      throw new Error('codex app-server request timed out: turn/start')
    }
    const sent = await send('look around')
    await vi.waitFor(() => expect(answers).toBe(2))
    await vi.waitFor(async () =>
      expect(verdictOf((await settled()).submissions, sent)).toBe('unknown')
    )

    expect(await settledWithin(stop(), CODEX_TURN_OPEN_WAIT_MS + 2_000)).not.toBe('held')

    expect(childCloses).toBe(1)
    expect(verdictOf((await settled()).submissions, sent)).toBe('withdrawn')
    expect(await statusRows()).toEqual([])
  })

  it('withdraws it too when the child end fails and a later retry lands it', async () => {
    failingCloses = 1
    const sent = await stoppedBeforeItsTurnOpened()
    expect(childCloses).toBe(0)

    await nextSendStartsANewChild()

    expect(childCloses).toBe(1)
    expect(verdictOf((await settled()).submissions, sent)).toBe('withdrawn')
  })

  // A turn that opened may hold the send: the child's end leaves it in doubt, as before.
  it('leaves a send in doubt when its turn opened before the child end', async () => {
    const sent = await send('look around')
    await vi.waitFor(() => expect(answers).toBe(1))
    turns.start()
    interruptsFail = true

    await stop()

    expect(childCloses).toBe(1)
    expect(verdictOf((await settled()).submissions, sent)).toBe('unknown')
    expect(await statusRows()).toEqual(['Cancellation requested.'])
  })

  // Handed over once the stopped turn read ended, it started its own turn, however late that
  // turn's own end then arrives; a second Stop finds its turn never opened.
  it('withdraws a send made after a Stop that started its own turn, which never opened', async () => {
    const opening = await send('look around')
    await vi.waitFor(() => expect(answers).toBe(1))
    turns.start()
    turns.echo(opening)
    interruptEndHeld = true
    await stop()
    interruptEndHeld = false
    const next = await send('run this after the stop')
    await vi.waitFor(() => expect(answers).toBe(2))
    // The stopped turn's own end arrives after the next send was handed over.
    turns.end('interrupted')

    await stopWhenItsTurnNeverOpens()

    expect(childCloses).toBe(1)
    expect(verdictOf((await settled()).submissions, next)).toBe('withdrawn')
  })

  // Codex drains a steer into the running turn, so it may hold one it never echoed.
  it('leaves a send steered into the open turn in doubt when the child end follows', async () => {
    const opening = await send('look around')
    await vi.waitFor(() => expect(answers).toBe(1))
    turns.start()
    turns.echo(opening)
    const steered = await send('and check the tests')
    await vi.waitFor(() => expect(steers).toBe(1))
    interruptsFail = true

    await stop('turn-1')

    expect(childCloses).toBe(1)
    expect(verdictOf((await settled()).submissions, steered)).toBe('unknown')
  })

  // Sent after the Stop, to a child that then dies before its turn opens: the Stop, still in force,
  // was never this send's.
  it('leaves a send made after the Stop in doubt when its child dies', async () => {
    await stoppedBeforeItsTurnOpened()
    const next = await nextSendStartsANewChild()

    handlers?.onExit?.(new Error('codex app-server exited'))

    await vi.waitFor(async () =>
      expect(verdictOf((await settled()).submissions, next)).not.toBe('pending')
    )
    expect(verdictOf((await settled()).submissions, next)).toBe('unknown')
  })
})

describe('a cold send with no Stop behind it', () => {
  /** Well inside one eviction step's budget, and far inside the bound a Stop waits. */
  const PROMPTLY_MS = 1_000

  async function answeredColdSend(): Promise<void> {
    await send('look around')
    await vi.waitFor(() => expect(answers).toBe(1))
    expect(turns.turnId).toBe('turn-1')
  }

  it('never delays closing the chat', async () => {
    await answeredColdSend()

    expect(await settledWithin(host.close(SESSION, 'evict'), PROMPTLY_MS)).not.toBe('held')
    expect(childCloses).toBe(1)
  })

  // Only a person's Stop takes a send back: a host's close leaves it in doubt, as before.
  it('leaves its send in doubt when the host closes the chat', async () => {
    await answeredColdSend()
    const sent = (await settled()).submissions[0]?.clientMessageId ?? ''

    await host.close(SESSION, 'evict')

    expect(childCloses).toBe(1)
    expect(verdictOf((await settled()).submissions, sent)).toBe('unknown')
  })

  it('never delays quitting the app', async () => {
    await answeredColdSend()

    expect(await settledWithin(stopStructuredAgentSessionRuntime(), PROMPTLY_MS)).not.toBe('held')
    expect(childCloses).toBe(1)
  })
})
