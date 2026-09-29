// A Codex send the turn it went into never took: the Stop that interrupts that turn
// withdraws it, and nothing reads as working after. Driven through the shipped host,
// journal and Codex adapter; only the Codex child is fake, keeping Codex 0.157's
// turn bookkeeping.

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
import {
  ensureStructuredAgentSessionHost,
  stopStructuredAgentSessionRuntime
} from './structured-agent-session-runtime'

// A Stop must never reach for real processes on this machine under a made-up pid.
vi.mock('../codex/codex-structured-turn-processes', () => ({
  captureCodexTurnProcesses: async () => null,
  terminateCodexTurnProcesses: async () => true
}))

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

async function stop(turnId: string): Promise<void> {
  const stopped = await host.cancel(CALLER, {
    envelope: envelope('agentSession.cancel', { turnId }),
    turnId
  })
  if (!stopped.ok) {
    throw new Error(JSON.stringify(stopped.refusal))
  }
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
  answers = 0
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
    // Steered: Codex answers with the running turn, and fires no second turn/started.
    await vi.waitFor(() => expect(answers).toBe(2))

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
