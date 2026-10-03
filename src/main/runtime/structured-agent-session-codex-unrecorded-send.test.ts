// A Codex send Codex took but never recorded: a hook of the person's blocked the prompt, or the
// turn it was answered into never opened. Codex echoes every input it records before the turn
// that took it completes, so once the thread stops running with no turn open such a send was not
// delivered: it settles so, the chat stops reading as working, and the next send goes out. A send
// whose request is still in flight then is left alone. Driven through the shipped host, journal and
// Codex adapter; only the Codex child is fake. The desktop then reads the host's rows as it does.

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
import { computeAgentSessionPayloadFingerprint } from '../../shared/agent-session-mutation-envelope'
import type { AgentJournalSnapshot } from '../../shared/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../shared/agent-session-journal-item-key'
import { classifyDispatchRejection } from '../../shared/structured-agent-session-dispatch-rejection'
import { owesStructuredAgentSessionWork } from '../../shared/structured-agent-session-owed-work'
import { projectStructuredAgentSessionMessages } from '../../shared/structured-agent-session-message-projection'
import {
  createStructuredAgentSessionOutboxEntry,
  reconcileStructuredAgentSessionOutbox
} from '../../shared/structured-agent-session-outbox'
import { admitStructuredAgentSessionOutboxEntry } from '../../shared/structured-agent-session-outbox-admission'
import { readWholeAgentSessionFailureFact } from '../../shared/agent-session-failure'
import { agentSessionFailureSentence } from '../../shared/agent-session-failure-words'
import { undeliveredSentElsewhere } from '../../shared/structured-agent-session-failed-start-elsewhere'
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

const CALLER = { callerKey: 'codex-unrecorded-send-test' }
const MODEL = {
  model: 'gpt-test',
  displayName: 'GPT Test',
  hidden: false,
  supportedReasoningEfforts: [],
  defaultReasoningEffort: null,
  isDefault: true
}
const NOT_DELIVERED = 'This message was not delivered. Send it again to continue.'

let root: string
let host: StructuredAgentSessionHost
let fence: number
let handlers: CodexAppServerConnectionHandlers | undefined
let answers: number
let steers: number
let turns: ReturnType<typeof codexTurnLifecycleFake>
/** While set, a `turn/steer` request waits for it before Codex answers. */
let steerAnswer: Promise<void> | null
let operations = 0

/** The durable ledger stamps its own clock and refuses an id far from it. */
const operationId = (): string => `${Date.now()}-${(++operations).toString(16).padStart(32, '0')}`

async function send(text: string): Promise<string> {
  const body = hostTestMessage(text)
  const sent = await host.send(CALLER, {
    envelope: {
      sessionId: SESSION,
      clientOperationId: operationId(),
      expectedRuntimeFence: fence,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.send',
        sessionId: SESSION,
        fields: { body }
      })
    },
    body
  })
  if (!sent.ok) {
    throw new Error(JSON.stringify(sent.refusal))
  }
  return sent.value.clientMessageId
}

/** Codex reports the thread no longer running, as it does once no turn is left open. */
function threadIdle(): void {
  handlers?.onNotification?.('thread/status/changed', {
    threadId: THREAD,
    status: { type: 'idle' }
  })
}

async function snapshot(): Promise<AgentJournalSnapshot> {
  await host.flushStreamedEvents(SESSION)
  return host.journalSnapshot(SESSION)
}

function verdictOf(journal: AgentJournalSnapshot, clientMessageId: string) {
  const submission = journal.submissions.find((entry) => entry.clientMessageId === clientMessageId)
  return submission?.dispatchState === 'rejected'
    ? classifyDispatchRejection(submission).kind
    : submission?.dispatchState
}

/** The shared rule every surface reads "working" from. */
function working(journal: AgentJournalSnapshot): boolean {
  return owesStructuredAgentSessionWork(journal.items, journal.submissions, fence)
}

/** The opening send, echoed, in a running turn. */
async function runningTurn(): Promise<void> {
  const opening = await send('look around')
  await vi.waitFor(() => expect(answers).toBe(1))
  turns.start()
  turns.echo(opening)
}

/** A follow-up Codex answered as a steer into the running turn. */
async function steered(text: string): Promise<string> {
  const before = steers
  const followUp = await send(text)
  await vi.waitFor(() => expect(steers).toBe(before + 1))
  return followUp
}

/** The send settled as not delivered, nothing reads as working, and the next send opens a turn. */
async function settlesNotDeliveredAndTheChatMovesOn(clientMessageId: string): Promise<void> {
  await vi.waitFor(async () =>
    expect(verdictOf(await snapshot(), clientMessageId)).toBe('notDelivered')
  )
  expect(working(await snapshot())).toBe(false)
  const before = answers
  await send('carry on')
  await vi.waitFor(() => expect(answers).toBe(before + 1))
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-codex-unrecorded-send-'))
  answers = 0
  steers = 0
  steerAnswer = null
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
          const answer = turns.routes['turn/steer'](params)
          await steerAnswer
          return answer
        }
        if (method === 'turn/interrupt') {
          return turns.routes['turn/interrupt'](params)
        }
        return {}
      },
      notify: () => {},
      respond: () => {},
      respondWithError: () => {},
      close: async () => true
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

describe('a Codex send Codex took and never recorded', () => {
  it('settles a blocked steer as not delivered once the thread stops running', async () => {
    await runningTurn()
    const followUp = await steered('and check the tests')
    // A hook blocked it: no echo, and the turn completes anyway.
    turns.end('completed')
    // The completed turn alone settles nothing: Codex echoes before it completes.
    expect(verdictOf(await snapshot(), followUp)).toBe('pending')

    threadIdle()

    await settlesNotDeliveredAndTheChatMovesOn(followUp)
  })

  it('settles a blocked send that opened its turn the same way', async () => {
    const opening = await send('look around')
    await vi.waitFor(() => expect(answers).toBe(1))
    turns.start()
    turns.end('completed')
    threadIdle()

    await settlesNotDeliveredAndTheChatMovesOn(opening)
  })

  it('settles a send whose answered turn never opened, with the process alive', async () => {
    const opening = await send('look around')
    await vi.waitFor(() => expect(answers).toBe(1))
    threadIdle()

    await settlesNotDeliveredAndTheChatMovesOn(opening)
  })

  // Codex can report the thread stopped before the interrupted turn's end reaches Orca.
  it('lets an interrupt withdraw the steer it ended, whichever Codex reports first', async () => {
    await runningTurn()
    const followUp = await steered('and check the tests')
    threadIdle()
    turns.end('interrupted')

    await vi.waitFor(async () => expect(verdictOf(await snapshot(), followUp)).toBe('cancelled'))
    expect(working(await snapshot())).toBe(false)
  })

  it('leaves a steer Codex echoed as delivered', async () => {
    await runningTurn()
    const followUp = await steered('and check the tests')
    turns.echo(followUp)
    turns.end('completed')
    threadIdle()

    await vi.waitFor(async () => expect(verdictOf(await snapshot(), followUp)).toBe('accepted'))
    expect(working(await snapshot())).toBe(false)
  })

  it('leaves a steer whose request is still in flight when the thread stops', async () => {
    await runningTurn()
    let answer!: () => void
    steerAnswer = new Promise((resolve) => {
      answer = resolve
    })
    const followUp = await steered('and check the tests')
    turns.end('completed')
    threadIdle()
    await snapshot()
    expect(verdictOf(await snapshot(), followUp)).toBe('pending')

    answer()
    await snapshot()
    expect(verdictOf(await snapshot(), followUp)).toBe('pending')
  })

  // The desktop's queue and transcript read the host's rows as they do on every device.
  it('draws the blocked steer as not delivered, and the queue behind it goes out', async () => {
    await runningTurn()
    const followUp = await steered('and check the tests')
    turns.end('completed')
    threadIdle()
    await vi.waitFor(async () => expect(verdictOf(await snapshot(), followUp)).toBe('notDelivered'))
    const journal = await snapshot()
    const key = agentJournalSubmissionKey(followUp)

    // Another device, with no copy of it: drawn from the row, unsent, in the words of its fact
    // with no Retry beside them.
    expect(
      projectStructuredAgentSessionMessages(journal.items, [], journal.submissions)
    ).toContainEqual(expect.objectContaining({ id: key, unsent: true }))
    const [row] = undeliveredSentElsewhere(journal.submissions, [])
    const fact = readWholeAgentSessionFailureFact(row?.rejection)
    expect(row?.clientMessageId).toBe(followUp)
    expect(fact && agentSessionFailureSentence(fact, 'rejection', { retryControl: false })).toBe(
      NOT_DELIVERED
    )

    // The sending desktop: its copy settles as not sent, and what it queued behind it goes out.
    const queued = (clientMessageId: string, text: string) =>
      createStructuredAgentSessionOutboxEntry({
        clientMessageId,
        sessionId: SESSION,
        text,
        attachments: [],
        queuedAt: 1
      })
    const next = queued('op-next', 'carry on')
    const outbox = reconcileStructuredAgentSessionOutbox(
      [
        { ...queued(followUp, 'and check the tests'), state: 'dispatching', lastAttemptAt: 1 },
        next
      ],
      journal.submissions
    )
    expect(outbox[0]).toMatchObject({ clientMessageId: followUp, state: 'rejected' })
    expect(admitStructuredAgentSessionOutboxEntry(outbox)).toEqual({
      state: 'dispatch',
      entry: next
    })
  })
})
