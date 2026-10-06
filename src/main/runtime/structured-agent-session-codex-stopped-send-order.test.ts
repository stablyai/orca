// Where a send a Stop took back is drawn: after the turn it waited on, never above that turn's own
// rows, and never below a later exchange, a restart included. Codex's resume rewrites every
// finished turn's start time to its own whole seconds, so the order is decided by the journal alone.
// Driven through the shipped host, journal and Codex adapter; only the Codex child is fake.

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
import { agentJournalSubmissionKey } from '../../shared/agent-session-journal-item-key'
import { computeAgentSessionPayloadFingerprint } from '../../shared/agent-session-mutation-envelope'
import type { AgentJournalSubmission } from '../../shared/agent-session-journal-types'
import { readAgentJournalTurn } from '../../shared/agent-session-turn-record'
import { NATIVE_CHAT_STOPPED_BEFORE_START_TEXT } from '../../shared/native-chat-stopped-before-start'
import { projectNativeChatTranscript } from '../../shared/native-chat-transcript-projection'
import { nativeChatRowsInDrawOrder } from '../../shared/native-chat-turn-grouping'
import {
  nativeChatTurnMembership,
  structuredAgentTurnAnchors
} from '../../shared/native-chat-turn-membership'
import { classifyDispatchRejection } from '../../shared/structured-agent-session-dispatch-rejection'
import { projectStructuredAgentSessionMessages } from '../../shared/structured-agent-session-message-projection'
import {
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD,
  hostTestAttachParams,
  hostTestMessage
} from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import { createStructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'
import {
  ensureStructuredAgentSessionHost,
  stopStructuredAgentSessionRuntime
} from './structured-agent-session-runtime'

const CALLER = { callerKey: 'codex-stopped-send-resume-test' }
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
let resumes: number
/** What `thread/resume` reports as the thread's turns, as Codex does: times in whole seconds. */
let resumeTurns: unknown[] | null
let turns: ReturnType<typeof codexTurnLifecycleFake>
/** Codex takes the interrupt and answers it; the test streams more and sends the end later. */
let interruptEndHeld: boolean
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

/** The chat's Stop; `turnId` names the turn it stops, as the phone does. */
function stop(turnId?: string): Promise<unknown> {
  const fields = turnId === undefined ? {} : { turnId }
  return host.cancel(CALLER, { envelope: envelope('agentSession.cancel', fields), ...fields })
}

function verdictOf(submissions: readonly AgentJournalSubmission[], clientMessageId: string) {
  const submission = submissions.find((entry) => entry.clientMessageId === clientMessageId)
  return submission?.dispatchState === 'rejected'
    ? classifyDispatchRejection(submission).category
    : submission?.dispatchState
}

async function submissions(): Promise<readonly AgentJournalSubmission[]> {
  await host.flushStreamedEvents(SESSION)
  return (await host.journalSnapshot(SESSION)).submissions
}

/** Each row's text, in the order every client draws the transcript, turns grouped. */
async function drawn(): Promise<string[]> {
  await host.flushStreamedEvents(SESSION)
  const { items, submissions } = await host.journalSnapshot(SESSION)
  const journal = { items, submissions }
  const { conversation } = projectNativeChatTranscript(
    projectStructuredAgentSessionMessages(items, [], submissions, { rejectedInPlace: true }),
    undefined,
    journal
  )
  return nativeChatRowsInDrawOrder(
    conversation,
    nativeChatTurnMembership(conversation, journal).drawOrder
  ).map((message) => message.blocks.map((block) => ('text' in block ? block.text : '')).join(''))
}

const openConnection: typeof openCodexAppServerConnection = async (
  _launch,
  connectionHandlers = {}
) => {
  handlers = connectionHandlers
  const connection: CodexAppServerConnection = {
    pid: 4321,
    closed: false,
    request: async (method, params) => {
      if (method === 'thread/resume') {
        resumes += 1
        return { thread: { id: THREAD, ...(resumeTurns ? { turns: resumeTurns } : {}) } }
      }
      if (method === 'thread/start') {
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
        return turns.routes['turn/steer'](params)
      }
      if (method === 'turn/interrupt' && interruptEndHeld) {
        turns.takeInterrupt()
        return {}
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

async function startHost(): Promise<void> {
  host = await ensureStructuredAgentSessionHost({
    logger: createStructuredAgentSessionLogger(),
    stateDirectory: root,
    hostId: 'local',
    claimKeyId: 'key-1',
    resolveWorkspacePath: async () => root,
    resolveClaudeAuthPolicy: () => ({ stripAuthEnv: true }),
    resolveCodexCommand: () => 'codex',
    resolveLaunchArgs: () => [],
    resolveEnvironment: async () => ({ PATH: process.env.PATH }),
    openCodexConnection: openConnection,
    readProcessStartTime: async () => 1_700_000_000_000
  })
}

async function attach(expected: number | null): Promise<void> {
  const params = hostTestAttachParams(expected, { providerHandle: undefined })
  params.envelope.clientOperationId = operationId()
  const attached = await host.attach(CALLER, params)
  if (attached.ok) {
    fence = attached.value.fence
    return
  }
  const refusal = JSON.stringify(attached.refusal)
  const current = /"currentFence":(\d+)/.exec(refusal)?.[1]
  if (current === undefined) {
    throw new Error(refusal)
  }
  await attach(Number(current))
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-codex-stopped-send-resume-'))
  answers = 0
  resumes = 0
  resumeTurns = null
  interruptEndHeld = false
  turns = codexTurnLifecycleFake(
    THREAD,
    () => (method, params) => handlers?.onNotification?.(method, params)
  )
  await startHost()
  await attach(null)
})

afterEach(async () => {
  await stopStructuredAgentSessionRuntime()
  await rm(root, { recursive: true, force: true })
})

describe("a send made while Codex held the first send's answer, then a Stop", () => {
  it("is drawn after the first send's interrupted turn, which streamed after the Stop", async () => {
    const release = turns.holdNextAnswer()
    const first = await send('first')
    await vi.waitFor(() => expect(answers).toBe(1))
    // Both wait on the session behind the held answer: the second send, then the Stop.
    const second = send('second')
    const stopping = stop()
    interruptEndHeld = true
    release()
    const secondId = await second
    await vi.waitFor(async () => expect(verdictOf(await submissions(), secondId)).toBe('withdrawn'))
    turns.start()
    turns.echo(first)
    // The turn opened after the second send was accepted, and streams after the Stop was pressed.
    handlers?.onNotification?.('item/completed', {
      threadId: THREAD,
      turn: { id: 'turn-1' },
      item: { type: 'agentMessage', id: 'streamed', text: 'streamed after the Stop' }
    })
    await settledWithin(stopping, 3_000)
    turns.end('interrupted')
    await vi.waitFor(async () =>
      expect(
        (await host.journalSnapshot(SESSION)).items
          .map((item) => readAgentJournalTurn(item.body))
          .find((turn) => turn?.turnId === 'turn-1')?.state
      ).toBe('interrupted')
    )

    // The Stop's own note is the host's to place; the order here is the stopped send's.
    const rows = (await drawn()).filter((text) => text !== 'Cancellation requested.')
    expect(rows.slice(rows.indexOf('first'))).toEqual([
      'first',
      'streamed after the Stop',
      'second',
      NATIVE_CHAT_STOPPED_BEFORE_START_TEXT
    ])
  })
})

describe('a send a Stop took back, then a send made while it read Stopping', () => {
  it('keeps the stopped send above the later exchange after a restart resumes the thread', async () => {
    const first = await send('look around')
    await vi.waitFor(() => expect(answers).toBe(1))
    // Codex has answered but not opened the turn, so the Stop waits for it to open.
    const stopping = stop()
    expect(await settledWithin(stopping, 500)).toBe('held')
    const second = await send('sent while stopping')
    turns.start()
    await settledWithin(stopping, 3_000)
    await vi.waitFor(async () => expect(verdictOf(await submissions(), first)).toBe('withdrawn'))
    await vi.waitFor(() => expect(answers).toBe(2))
    turns.start()
    turns.echo(second)
    turns.end('completed')
    await vi.waitFor(async () => expect(verdictOf(await submissions(), second)).toBe('accepted'))
    const live = await drawn()
    expect(live).toEqual([
      'look around',
      NATIVE_CHAT_STOPPED_BEFORE_START_TEXT,
      'sent while stopping'
    ])

    // Restart: the resume reports each finished turn with its start in Codex's whole seconds.
    resumeTurns = (await host.journalSnapshot(SESSION)).items.flatMap((item) => {
      const turn = readAgentJournalTurn(item.body)
      return turn?.startedAt !== undefined && turn.turnId.startsWith('turn-')
        ? [
            {
              id: turn.turnId,
              status: 'completed',
              startedAt: Math.floor(turn.startedAt / 1000),
              completedAt: Math.ceil((turn.completedAt ?? turn.startedAt) / 1000) + 1,
              items: []
            }
          ]
        : []
    })
    await stopStructuredAgentSessionRuntime()
    await startHost()
    await attach(fence)
    await vi.waitFor(() => expect(resumes).toBeGreaterThan(0))
    await vi.waitFor(async () => {
      const restored = (await host.journalSnapshot(SESSION)).items
        .map((item) => readAgentJournalTurn(item.body)?.startedAt)
        .find((startedAt) => startedAt !== undefined)
      expect((restored ?? 1) % 1000).toBe(0)
    })

    expect(await drawn()).toEqual(live)
  })
})

describe('a send a Stop took back before Codex echoed it', () => {
  it('is drawn as the opener of the turn Codex opened for it, with no row of its own', async () => {
    const sent = await send('look around')
    await vi.waitFor(() => expect(answers).toBe(1))
    turns.start()
    await stop('turn-1')
    await vi.waitFor(async () => expect(verdictOf(await submissions(), sent)).toBe('withdrawn'))

    // Codex opened its turn before echoing it, so that turn, ended interrupted, is the send's: it
    // carries the stop, and no row of its own follows the send.
    const snapshot = await host.journalSnapshot(SESSION)
    const turnRecord = snapshot.items.find(
      (item) => readAgentJournalTurn(item.body)?.turnId === 'turn-1'
    )
    expect(
      structuredAgentTurnAnchors(snapshot.items, snapshot.submissions).get(turnRecord!.itemId)
    ).toBe(agentJournalSubmissionKey(sent))
    expect(await drawn()).toEqual(['look around', 'Cancellation requested.'])
  })

  it('is drawn where it was sent, then the one row saying it never started, when no turn opened', async () => {
    const warmUp = await send('warm up')
    await vi.waitFor(() => expect(answers).toBe(1))
    turns.start()
    turns.echo(warmUp)
    turns.end('completed')
    const release = turns.holdNextAnswer()
    const sent = await send('look around')
    await vi.waitFor(() => expect(answers).toBe(2))
    const stopping = stop()
    release()
    // The Stop waits out the turn-open wait for a turn that never opens, then ends there.
    expect(await settledWithin(stopping, CODEX_TURN_OPEN_WAIT_MS + 2_000)).not.toBe('held')
    expect(verdictOf(await submissions(), sent)).toBe('withdrawn')

    // Every client draws the send where it was sent, then the one row saying it never started.
    await host.flushStreamedEvents(SESSION)
    const { items, submissions: settled } = await host.journalSnapshot(SESSION)
    const messages = projectStructuredAgentSessionMessages(items, [], settled, {
      rejectedInPlace: true
    })
    expect(messages.slice(-2).map((message) => [message.role, message.blocks])).toEqual([
      ['user', [{ type: 'text', text: 'look around' }]],
      ['system', [expect.objectContaining({ text: NATIVE_CHAT_STOPPED_BEFORE_START_TEXT })]]
    ])
    expect(await drawn()).toEqual(['warm up', 'look around', NATIVE_CHAT_STOPPED_BEFORE_START_TEXT])
  })
})
