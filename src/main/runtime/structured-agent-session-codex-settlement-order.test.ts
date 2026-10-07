// Codex's own frames go through the event sink; the settlements they prove (a failed turn's
// rejection, an echo's acceptance) are written straight to the journal. Each settlement must land
// after the frame that proved it, even with an earlier streamed write issued in the same read.
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
import { computeAgentSessionPayloadFingerprint } from '../../shared/agent-session-mutation-envelope'
import type {
  AgentJournalDispatchState,
  AgentJournalTurnItem
} from '../../shared/agent-session-journal-types'
import {
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD,
  hostTestAttachParams,
  hostTestMessage
} from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import {
  liveTestJournalRows,
  openTestJournalHostDatabase
} from '../native-chat/agent-session-journal/journal-host-database-test-support'
import {
  parseJournalRow,
  type JournalLifecycleMutation,
  type JournalRow
} from '../native-chat/agent-session-journal/journal-row-schema'
import { createStructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'
import {
  ensureStructuredAgentSessionHost,
  stopStructuredAgentSessionRuntime
} from './structured-agent-session-runtime'

const CALLER = { callerKey: 'codex-settlement-order-test' }
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

/** A stored row, or one mutation of a lifecycle batch: what a settlement or a frame lands as. */
type JournalEntry = JournalRow | JournalLifecycleMutation

/** The sequence of the first row that `matches`, or of the lifecycle batch carrying it. */
function seqOf(matches: (entry: JournalEntry) => boolean): number | undefined {
  return liveTestJournalRows(openTestJournalHostDatabase(root).db, SESSION).find((stored) => {
    const parsed = parseJournalRow(stored.rowJson)
    if (!parsed.ok) {
      return false
    }
    const { row } = parsed
    return (
      matches(row) ||
      (row.kind === 'lifecycle-batch' && row.mutations.some((mutation) => matches(mutation)))
    )
  })?.seq
}

const dispatchRow =
  (clientMessageId: string, state: AgentJournalDispatchState) => (entry: JournalEntry) =>
    entry.kind === 'dispatch' && entry.clientMessageId === clientMessageId && entry.state === state

/** The turn lifecycle an item row or mutation carries, if it carries one. */
function turnOf(entry: JournalEntry): AgentJournalTurnItem | null {
  return entry.kind === 'item' && entry.body.kind === 'turn' ? entry.body : null
}

/** An assistant reply Codex finishes in the same read as the frame under test. */
function streamedReplyAhead(): void {
  handlers?.onNotification?.('item/completed', {
    threadId: THREAD,
    turn: { id: 'turn-1' },
    item: { type: 'agentMessage', id: 'item-reply', text: 'Done looking.' }
  })
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-codex-settlement-order-'))
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
      request: async (method) => {
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
  await stopStructuredAgentSessionRuntime()
  await rm(root, { recursive: true, force: true })
})

describe('a settlement Codex proves keeps its place behind the frame that proved it', () => {
  it('rejects a send only after the failed turn that refused it has ended', async () => {
    const sent = await send('look around')
    await vi.waitFor(() => expect(answers).toBe(1))
    turns.start()

    streamedReplyAhead()
    turns.end('failed', 'The model is overloaded.')

    await vi.waitFor(() => expect(seqOf(dispatchRow(sent, 'rejected'))).toBeDefined())
    await host.flushStreamedEvents(SESSION)
    const ended = seqOf((entry) => {
      const turn = turnOf(entry)
      return turn !== null && turn.state !== 'running'
    })
    expect(ended).toBeDefined()
    expect(seqOf(dispatchRow(sent, 'rejected'))).toBeGreaterThan(ended!)
  })

  it('accepts a send only after the echo that proves it has landed', async () => {
    const sent = await send('look around')
    await vi.waitFor(() => expect(answers).toBe(1))
    turns.start()

    streamedReplyAhead()
    turns.echo(sent)

    await vi.waitFor(() => expect(seqOf(dispatchRow(sent, 'accepted'))).toBeDefined())
    await host.flushStreamedEvents(SESSION)
    // The echo reconciles into the send's own bubble: its row is the turn now naming that send.
    const echoed = seqOf((entry) => turnOf(entry)?.userItemId === `orca:${sent}`)
    expect(echoed).toBeDefined()
    expect(seqOf(dispatchRow(sent, 'accepted'))).toBeGreaterThan(echoed!)
  })
})
