// A message queued behind a send whose Codex turn has not opened yet waits for that turn: handed
// over once it opens, it goes in as a steer and its row belongs to that turn, never ahead of it.
// Driven through the shipped host, journal and Codex adapter; only the Codex child is fake, keeping
// Codex 0.157's turn bookkeeping, and the rows are drawn by the client's own projection.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { agentJournalSubmissionKey } from '../../shared/agent-session-journal-item-key'
import { CODEX_TURN_OPEN_WAIT_MS } from '../codex/codex-structured-turn-open-wait'
import { projectStructuredAgentSessionMessages } from '../../shared/structured-agent-session-message-projection'
import { projectNativeChatTranscriptMessages } from '../../shared/native-chat-transcript-projection'
import { nativeChatRowsInDrawOrder } from '../../shared/native-chat-turn-grouping'
import { nativeChatTurnMembership } from '../../shared/native-chat-turn-membership'
import {
  CodexAppServerRequestError,
  type CodexAppServerConnection,
  type CodexAppServerConnectionHandlers,
  type openCodexAppServerConnection
} from '../codex/codex-app-server-connection'
import { codexTurnLifecycleFake } from '../codex/codex-turn-lifecycle-fake'
import { settledWithin } from '../codex/codex-structured-dispatch-test-support'
import type * as CodexTurnOpenWait from '../codex/codex-structured-turn-open-wait'
import { computeAgentSessionPayloadFingerprint } from '../../shared/agent-session-mutation-envelope'
import type { AgentJournalSubmission } from '../../shared/agent-session-journal-types'
import { classifyDispatchRejection } from '../../shared/structured-agent-session-dispatch-rejection'
import { owesStructuredAgentSessionWork } from '../../shared/structured-agent-session-owed-work'
import { readAgentJournalTurn } from '../../shared/agent-session-turn-record'
import {
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD,
  hostTestAttachParams,
  hostTestMessage
} from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
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

const CALLER = { callerKey: 'codex-opening-send-test' }
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
  root = await mkdtemp(join(tmpdir(), 'orca-codex-opening-send-'))
  openWaits.turnIds.length = 0
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

/** Each row's text and the turn it is drawn in, in the order the client draws the conversation. */
async function drawn(): Promise<{ text: string; turn: string | undefined }[]> {
  await host.flushStreamedEvents(SESSION)
  const { items, submissions } = await host.journalSnapshot(SESSION)
  const rows = projectNativeChatTranscriptMessages(
    projectStructuredAgentSessionMessages(items, [], submissions, { rejectedInPlace: true })
  )
  const { drawOrder, turnKeys } = nativeChatTurnMembership(rows, { items, submissions })
  const keyed = rows.map((row, index) => ({
    text: row.blocks.map((block) => ('text' in block ? block.text : block.type)).join(''),
    turn: turnKeys[index]
  }))
  return [...nativeChatRowsInDrawOrder(keyed, drawOrder)]
}

/** The turn the client draws as live: its bar carries the running clock. */
async function liveTurn(): Promise<string | undefined> {
  await host.flushStreamedEvents(SESSION)
  const { items, submissions } = await host.journalSnapshot(SESSION)
  const rows = projectNativeChatTranscriptMessages(
    projectStructuredAgentSessionMessages(items, [], submissions, { rejectedInPlace: true })
  )
  return nativeChatTurnMembership(rows, { items, submissions }).liveTurnKey
}

/** The delivery loop has stopped: it handed over what it could, and holds the rest. */
async function deliveryAtRest(): Promise<void> {
  const { loop } = host.collaboratorsForTests().conversationDelivery
  await vi.waitFor(() => expect(loop.isRunning(SESSION)).toBe(false))
}

async function submission(clientMessageId: string) {
  return (await settled()).submissions.find((entry) => entry.clientMessageId === clientMessageId)
}

/** The turn its row is in: the turn it was steered into, or none for a send that opens its own. */
async function rowScope(clientMessageId: string) {
  const { items } = await host.journalSnapshot(SESSION)
  return items.find((item) => item.itemId === agentJournalSubmissionKey(clientMessageId))?.turnScope
}

/** A finished first turn, then `/compact` running, so the sends that follow queue behind it. */
async function compactRunning(): Promise<{ compacted: Promise<unknown> }> {
  const warmUp = await send('warm up')
  await vi.waitFor(() => expect(answers).toBe(1))
  turns.start()
  turns.echo(warmUp)
  turns.end('completed')
  const compacted = compact()
  await vi.waitFor(async () =>
    expect(
      (await host.journalSnapshot(SESSION)).items.some(
        (item) => readAgentJournalTurn(item.body)?.state === 'running'
      )
    ).toBe(true)
  )
  return { compacted }
}

/** Codex compacts and ends that turn; the host then hands the first queued send over. */
async function finishCompaction({ compacted }: { compacted: Promise<unknown> }): Promise<void> {
  handlers?.onNotification?.('turn/started', {
    threadId: THREAD,
    turn: { id: 'turn-compact', status: 'inProgress' }
  })
  handlers?.onNotification?.('thread/compacted', { threadId: THREAD })
  handlers?.onNotification?.('turn/completed', {
    threadId: THREAD,
    turn: { id: 'turn-compact', status: 'completed' }
  })
  expect(await settledWithin(compacted, 3_000)).not.toBe('held')
}

function says(text: string, id: string): void {
  handlers?.onNotification?.('item/completed', {
    threadId: THREAD,
    turn: { id: turns.turnId },
    item: { type: 'agentMessage', id, text }
  })
}

describe("a message queued behind a send whose turn hasn't opened", () => {
  it('waits for that turn, then joins it as a steer, drawn in it with the turn streaming on', async () => {
    const compaction = await compactRunning()
    const first = await send('queued first')
    const second = await send('queued second')
    await finishCompaction(compaction)
    await vi.waitFor(async () => expect((await submission(first))?.handedOverAt).toBeDefined())
    await vi.waitFor(() => expect(answers).toBe(2))
    await deliveryAtRest()

    expect((await submission(second))?.handedOverAt).toBeUndefined()
    expect(openWaits.turnIds).toEqual([])

    turns.start()
    await vi.waitFor(async () => expect((await submission(second))?.handedOverAt).toBeDefined())
    await vi.waitFor(() => expect(steers).toBe(1))
    turns.echo(first)
    says('working on the first', 'reply-1')
    says('more on both', 'reply-2')

    expect(answers).toBe(2)
    expect(await rowScope(second)).toMatchObject({ kind: 'turn' })
    const rows = await drawn()
    expect(rows.map((row) => row.text)).toEqual([
      'warm up',
      '/compact',
      'Context compacted',
      'queued first',
      'queued second',
      'working on the first',
      'more on both'
    ])
    const turnOf = (text: string) => rows.find((row) => row.text === text)?.turn
    expect(turnOf('queued second')).toBe(turnOf('queued first'))
    expect(turnOf('more on both')).toBe(turnOf('queued first'))
  })

  it('lets each message behind it go in as a steer once the turn opens, in the order sent', async () => {
    const compaction = await compactRunning()
    const zero = await send('queued zero')
    const a = await send('queued A')
    const b = await send('queued B')
    await finishCompaction(compaction)
    await vi.waitFor(async () => expect((await submission(zero))?.handedOverAt).toBeDefined())
    await deliveryAtRest()

    expect((await submission(a))?.handedOverAt).toBeUndefined()
    expect((await submission(b))?.handedOverAt).toBeUndefined()

    turns.start()
    await vi.waitFor(() => expect(steers).toBe(2))
    turns.echo(zero)
    says('working on zero', 'reply-0')

    expect(await rowScope(a)).toMatchObject({ kind: 'turn' })
    expect(await rowScope(b)).toMatchObject({ kind: 'turn' })
    const rows = await drawn()
    expect(rows.map((row) => row.text).slice(3)).toEqual([
      'queued zero',
      'queued A',
      'queued B',
      'working on zero'
    ])
    expect(new Set(rows.slice(3).map((row) => row.turn)).size).toBe(1)
  })

  // A Stop withdraws what is still queued, so the held message is taken back, never sent.
  it('is withdrawn with the queue by a Stop pressed before that turn opens', async () => {
    const compaction = await compactRunning()
    const zero = await send('queued zero')
    const b = await send('queued B')
    await finishCompaction(compaction)
    await vi.waitFor(async () => expect((await submission(zero))?.handedOverAt).toBeDefined())
    await deliveryAtRest()
    expect((await submission(b))?.handedOverAt).toBeUndefined()

    await stop()

    await vi.waitFor(async () =>
      expect(verdictOf((await settled()).submissions, b)).toBe('withdrawn')
    )
    expect((await submission(b))?.handedOverAt).toBeUndefined()
    expect(answers).toBe(2)
    expect(steers).toBe(0)
  })

  // Its turn/start answer lost, the send ahead settles as doubt at once, and that releases the wait.
  it('goes in at once when the send ahead lost its answer', async () => {
    const compaction = await compactRunning()
    const answer = turns.routes['turn/start']
    turns.routes['turn/start'] = () => {
      turns.routes['turn/start'] = answer
      throw new Error('codex app-server request timed out: turn/start')
    }
    const first = await send('queued first')
    const second = await send('queued second')
    await finishCompaction(compaction)

    await vi.waitFor(async () => expect((await submission(second))?.handedOverAt).toBeDefined())
    expect(verdictOf((await settled()).submissions, first)).toBe('unknown')
    expect(answers).toBe(3)
  })

  // A steer still unanswered joined a turn that is open; it opens nothing, so nothing waits on it.
  it('never holds a message sent into a turn already running, nor one behind such a steer', async () => {
    const warmUp = await send('warm up')
    await vi.waitFor(() => expect(answers).toBe(1))
    turns.start()
    turns.echo(warmUp)

    const steered = await send('and also this')
    const after = await send('and this too')

    await vi.waitFor(() => expect(steers).toBe(2))
    expect(await rowScope(steered)).toMatchObject({ kind: 'turn' })
    expect(await rowScope(after)).toMatchObject({ kind: 'turn' })
    expect(openWaits.turnIds).toEqual([])
  })
})

describe('a send whose turn Codex answered and never opened', () => {
  async function heldBehindAnAnsweredSend(): Promise<{ first: string; second: string }> {
    const first = await send('look around')
    await vi.waitFor(() => expect(answers).toBe(1))
    const second = await send('and check the tests')
    await deliveryAtRest()
    expect((await submission(second))?.handedOverAt).toBeUndefined()
    return { first, second }
  }

  // Codex before 0.148 fails a turn before opening it with only an `error`: that is its end.
  it('releases the message behind it once Codex fails that turn before opening it', async () => {
    turns = codexTurnLifecycleFake(
      THREAD,
      () => (method, params) => handlers?.onNotification?.(method, params),
      { legacyStartAnswers: true }
    )
    const { first, second } = await heldBehindAnAnsweredSend()

    turns.failUnopened('invalid turn settings')

    await vi.waitFor(async () => expect((await submission(second))?.handedOverAt).toBeDefined())
    expect(await submission(first)).toMatchObject({ dispatchState: 'rejected' })
    expect(JSON.stringify(await submission(first))).toContain('invalid turn settings')
    // A turn Codex never opened has no record in the journal to name.
    expect((await submission(first))?.answeredInTurn).toBeNull()
    await vi.waitFor(() => expect(answers).toBe(2))
    expect(openWaits.turnIds).toEqual([])
  })

  // No clock: however long Codex takes to open the turn, the send ahead is never doubted for it.
  it('never doubts a send whose turn is slow to open, and holds the next until it opens', async () => {
    const { first, second } = await heldBehindAnAnsweredSend()

    vi.useFakeTimers()
    await vi.advanceTimersByTimeAsync(CODEX_TURN_OPEN_WAIT_MS * 3)
    vi.useRealTimers()

    expect(verdictOf((await settled()).submissions, first)).toBe('pending')
    expect((await submission(second))?.handedOverAt).toBeUndefined()
    turns.start()
    await vi.waitFor(() => expect(steers).toBe(1))
    turns.echo(first)
    await vi.waitFor(async () =>
      expect(verdictOf((await settled()).submissions, first)).toBe('accepted')
    )
  })

  // Steered in the moment the turn opens, it can be echoed before the send that opened the turn.
  it('keeps the turn, and its live status, on the send that opened it when the steer echoes first', async () => {
    const { first, second } = await heldBehindAnAnsweredSend()
    turns.start()
    await vi.waitFor(() => expect(steers).toBe(1))

    turns.echo(second)
    await vi.waitFor(async () =>
      expect(verdictOf((await settled()).submissions, second)).toBe('accepted')
    )

    expect(verdictOf((await settled()).submissions, first)).toBe('pending')
    const rows = await drawn()
    expect(rows.map((row) => row.text)).toEqual(['look around', 'and check the tests'])
    expect(new Set(rows.map((row) => row.turn))).toEqual(
      new Set([agentJournalSubmissionKey(first)])
    )
    expect(await liveTurn()).toBe(agentJournalSubmissionKey(first))
  })
})

// Codex reports the thread idle ahead of the `turn/completed` of a turn it opened, as the fake does.
describe('a send in a turn Codex opened, when Codex reports the thread idle', () => {
  function lateSettlements(clientMessageId: string) {
    return vi
      .mocked(host.settleLateDispatch)
      .mock.calls.map(([settlement]) => settlement)
      .filter((settlement) => settlement.clientMessageId === clientMessageId)
      .map((settlement) => ('state' in settlement ? settlement.state : 'accepted'))
  }

  it('is never doubted for the idle when it was steered in and a Stop takes it back', async () => {
    vi.spyOn(host, 'settleLateDispatch')
    const warmUp = await send('warm up')
    await vi.waitFor(() => expect(answers).toBe(1))
    turns.start()
    turns.echo(warmUp)
    const steered = await send('and also this')
    await vi.waitFor(() => expect(steers).toBe(1))

    await stop()

    await vi.waitFor(async () =>
      expect(verdictOf((await settled()).submissions, steered)).toBe('withdrawn')
    )
    expect(lateSettlements(steered)).toEqual(['rejected'])
  })

  it('is never doubted for the idle when it opened the turn and a Stop ends it before the echo', async () => {
    vi.spyOn(host, 'settleLateDispatch')
    const first = await send('look around')
    await vi.waitFor(() => expect(answers).toBe(1))
    turns.start()

    await stop()

    await vi.waitFor(async () =>
      expect(verdictOf((await settled()).submissions, first)).toBe('withdrawn')
    )
    expect(lateSettlements(first)).toEqual(['rejected'])
  })

  it('raises no doubt when its turn completes with it echoed', async () => {
    vi.spyOn(host, 'settleLateDispatch')
    const first = await send('look around')
    await vi.waitFor(() => expect(answers).toBe(1))
    turns.start()
    turns.echo(first)
    turns.end('completed')
    const second = await send('next')
    await vi.waitFor(async () => expect((await submission(second))?.handedOverAt).toBeDefined())

    expect(lateSettlements(first)).toEqual(['accepted'])
    expect(verdictOf((await settled()).submissions, first)).toBe('accepted')
  })
})
