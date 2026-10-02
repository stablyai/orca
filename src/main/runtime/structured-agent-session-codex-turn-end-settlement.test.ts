// A Codex send the turn it went into never took: the Stop that interrupts that turn
// withdraws it, and nothing reads as working after. A send made while that turn runs, a
// queued card's Send-now included, goes in as `turn/steer` naming it. A Stop or a send made
// before Codex opens that turn waits for it to open, since Codex refuses an interrupt until then.
// Driven through the shipped host, journal and Codex adapter; only the Codex child is fake,
// keeping Codex 0.157's turn bookkeeping.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  CodexAppServerConnection,
  CodexAppServerConnectionHandlers,
  openCodexAppServerConnection
} from '../codex/codex-app-server-connection'
import { codexTurnLifecycleFake } from '../codex/codex-turn-lifecycle-fake'
import { settledWithin } from '../codex/codex-structured-dispatch-test-support'
import { CODEX_TURN_OPEN_WAIT_MS } from '../codex/codex-structured-turn-open-wait'
import type * as CodexTurnOpenWait from '../codex/codex-structured-turn-open-wait'
import { computeAgentSessionPayloadFingerprint } from '../../shared/agent-session-mutation-envelope'
import type { AgentJournalSubmission } from '../../shared/agent-session-journal-types'
import { classifyDispatchRejection } from '../../shared/structured-agent-session-dispatch-rejection'
import { owesStructuredAgentSessionWork } from '../../shared/structured-agent-session-owed-work'
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

// The turns a send or Stop is waiting on to open, so a test knows the wait began.
const openWaits = vi.hoisted(() => {
  const turnIds: string[] = []
  return { turnIds }
})
vi.mock('../codex/codex-structured-turn-open-wait', async (importOriginal) => {
  const actual = await importOriginal<typeof CodexTurnOpenWait>()
  return {
    ...actual,
    createCodexTurnOpenWaits: () => {
      const waits = actual.createCodexTurnOpenWaits()
      return {
        ...waits,
        wait: (turnId: string, withinMs: number) => {
          openWaits.turnIds.push(turnId)
          return waits.wait(turnId, withinMs)
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
    delivery,
    userSend: true
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

function verdictOf(submissions: readonly AgentJournalSubmission[], clientMessageId: string) {
  const submission = submissions.find((entry) => entry.clientMessageId === clientMessageId)
  return submission?.dispatchState === 'rejected'
    ? classifyDispatchRejection(submission).category
    : submission?.dispatchState
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-codex-turn-end-'))
  openWaits.turnIds.length = 0
  answers = 0
  steers = 0
  interrupts = 0
  childCloses = 0
  turns = codexTurnLifecycleFake(
    THREAD,
    () => (method, params) => handlers?.onNotification?.(method, params)
  )
  const openConnection: typeof openCodexAppServerConnection = async (
    _launch,
    connectionHandlers = {}
  ) => {
    handlers = connectionHandlers
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

describe('a queued card sent now into the turn a Stop ends', () => {
  async function handoffs(messageId: string): Promise<AgentJournalSubmission[]> {
    return (await settled()).submissions.filter((entry) => entry.queuedMessageId === messageId)
  }

  /** Each hand-off of the card, as who sent it and how it settled. */
  async function sends(messageId: string) {
    return (await handoffs(messageId)).map((entry) => ({
      origin: entry.origin,
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
          sends: [{ origin: 'client', verdict: 'withdrawn' }]
        }),
      { timeout: 5_000 }
    )
    // A drain ignoring the pause re-sends only after the stopped turn ends: watch past that.
    await vi.waitFor(() => expect(turns.turnId).toBeNull())
    await new Promise((resolve) => setTimeout(resolve, 2_500))
    expect(steers + answers).toBe(2)
    expect(await sends(cardId)).toEqual([{ origin: 'client', verdict: 'withdrawn' }])
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
    await vi.waitFor(() => expect(openWaits.turnIds).toEqual(['turn-1']))
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
  it('waits for the turn to open, then stops it and withdraws the send', async () => {
    const sent = await send('look around')
    await vi.waitFor(() => expect(answers).toBe(1))

    const stopping = stop()
    // Without the wait, it would reach Codex now, which would refuse it, and be done.
    expect(await settledWithin(stopping, 1_000)).toBe('held')
    expect(interrupts).toBe(0)
    turns.start()
    await stopping

    expect(interrupts).toBe(1)
    expect(turns.turnId).toBeNull()
    await vi.waitFor(async () =>
      expect(verdictOf((await settled()).submissions, sent)).toBe('withdrawn')
    )
    expect((await settled()).owesWork).toBe(false)
  })
})

describe('a Stop in that window that the turn never opens for', () => {
  async function statusRows(): Promise<string[]> {
    return (await host.journalSnapshot(SESSION)).items.flatMap((item) =>
      item.body.kind === 'status' ? [item.body.text] : []
    )
  }

  async function waitingStop(): Promise<{ stopping: Promise<void> }> {
    await send('look around')
    await vi.waitFor(() => expect(answers).toBe(1))
    const stopping = stop()
    expect(await settledWithin(stopping, 200)).toBe('held')
    return { stopping }
  }

  it('says Codex had no turn running when that turn ends first', async () => {
    const { stopping } = await waitingStop()

    turns.end('interrupted')
    await stopping

    expect(interrupts).toBe(0)
    expect(await statusRows()).toContain('Codex had no turn running to stop.')
  })

  it('lets a chat closed behind it close within its bound and one eviction', async () => {
    const { stopping } = await waitingStop()

    const closing = host.close(SESSION, 'evict')

    expect(
      await settledWithin(closing, CODEX_TURN_OPEN_WAIT_MS + CHILD_EVICTION_TIMEOUT_MS)
    ).not.toBe('held')
    expect(await settledWithin(stopping, 0)).not.toBe('held')
    expect(childCloses).toBe(1)
    expect(interrupts).toBe(0)
    expect(await statusRows()).toContain('Codex had no turn running to stop.')
  })

  it('lets the app quit behind it within the eviction budget, and still close the child', async () => {
    await waitingStop()

    expect(
      await settledWithin(stopStructuredAgentSessionRuntime(), CHILD_EVICTION_TIMEOUT_MS)
    ).not.toBe('held')
    expect(childCloses).toBe(1)
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

  it('never delays quitting the app', async () => {
    await answeredColdSend()

    expect(await settledWithin(stopStructuredAgentSessionRuntime(), PROMPTLY_MS)).not.toBe('held')
    expect(childCloses).toBe(1)
  })
})
