// Drive the real host/journal/adapter with fake Codex: interrupt answers precede turn/completed, so Stop settlement must prevent a transient failed turn.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  CodexAppServerConnection,
  CodexAppServerConnectionHandlers
} from '../codex/app-server/codex-app-server-connection-types'
import type { openCodexAppServerConnection } from '../codex/codex-app-server-connection'
import { readCodexTurnId } from '../codex/codex-structured-thread-facts'
import { codexTurnLifecycleFake } from '../codex/codex-turn-lifecycle-fake'
import { computeAgentSessionPayloadFingerprint } from '../../shared/agent-session-mutation-envelope'
import type { AgentJournalTurnItem } from '../../shared/agent-session-journal-types'
import type { AgentSessionStatusSummary } from '../../shared/agent-session-wire'
import { owesStructuredAgentSessionWork } from '../../shared/structured-agent-session-owed-work'
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
import { parseJournalRow } from '../native-chat/agent-session-journal/journal-row-schema'
import { createStructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'
import {
  ensureStructuredAgentSessionHost,
  stopStructuredAgentSessionRuntime
} from './structured-agent-session-runtime'
import { scriptedCodexTransport } from './scripted-codex-transport.test-fixture'

const CALLER = { callerKey: 'codex-interrupt-order-test' }
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
let interrupts: number
let turns: ReturnType<typeof codexTurnLifecycleFake>
let statuses: AgentSessionStatusSummary[]
let opened: Set<string>
let steers: number
let startedTurns: string[]
/** When set, Codex answers the interrupt only once it resolves. */
let interruptAnswer: Promise<void> | null
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
  await host.collaboratorsForTests().serialize(SESSION, async () => {})
}

/** Every end row written for turn-1, as a row or a lifecycle batch's mutation, in order. */
function turnEndRows(): AgentJournalTurnItem[] {
  return liveTestJournalRows(openTestJournalHostDatabase(root).db, SESSION).flatMap((stored) => {
    const parsed = parseJournalRow(stored.rowJson)
    if (!parsed.ok) {
      return []
    }
    const { row } = parsed
    const bodies = row.kind === 'lifecycle-batch' ? row.mutations : [row]
    return bodies.flatMap((entry) =>
      entry.kind === 'item' &&
      entry.body.kind === 'turn' &&
      entry.body.turnId === 'turn-1' &&
      entry.body.state !== 'running'
        ? [entry.body]
        : []
    )
  })
}

/** After Stop answers, deliver its pending turn end and verify no intermediate failed status. */
async function expectInterruptedThroughout(): Promise<void> {
  expect(interrupts).toBe(1)
  expect(turnEndRows()).toEqual([
    expect.objectContaining({ state: 'interrupted', outcome: 'cancellation' })
  ])

  turns.end('interrupted')

  await vi.waitFor(async () => expect(await owesWork()).toBe(false))
  const ends = turnEndRows()
  expect(ends.length).toBeGreaterThan(0)
  for (const end of ends) {
    expect(end).toMatchObject({ state: 'interrupted', outcome: 'cancellation' })
  }
  await vi.waitFor(() =>
    expect(statuses.at(-1)).toMatchObject({ status: 'idle', turnOutcome: 'cancellation' })
  )
  expect(statuses.some((summary) => summary.stopping === true)).toBe(true)
  expect(statuses.at(-1)).not.toHaveProperty('stopping')
  const otherVerdicts = statuses.filter(
    (summary) => summary.turnOutcome !== undefined && summary.turnOutcome !== 'cancellation'
  )
  expect(otherVerdicts).toEqual([])
}

async function owesWork(): Promise<boolean> {
  const snapshot = await host.journalSnapshot(SESSION)
  return owesStructuredAgentSessionWork(snapshot.items, snapshot.submissions, fence)
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-codex-interrupt-order-'))
  answers = 0
  interrupts = 0
  opened = new Set()
  steers = 0
  startedTurns = []
  interruptAnswer = null
  turns = codexTurnLifecycleFake(THREAD, () => (method, params) => {
    if (method === 'turn/started') {
      opened.add(turns.turnId ?? '')
    }
    handlers?.onNotification?.(method, params)
  })
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
          const answer = await turns.routes['turn/start']()
          startedTurns.push(readCodexTurnId(answer) ?? '')
          return answer
        }
        if (method === 'turn/steer') {
          steers += 1
          return turns.routes['turn/steer'](params)
        }
        if (method === 'turn/interrupt') {
          // Codex emits any unread turn/started before answering; the test sends turn/completed afterward.
          interrupts += 1
          if (turns.turnId !== null && !opened.has(turns.turnId)) {
            turns.start()
          }
          await interruptAnswer
          // Codex drops the turn as its active one before it answers; turn/completed comes later.
          turns.takeInterrupt()
          return {}
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
    resolveClaudeAuthPolicy: () => ({ account: 'managed' }),
    resolveCodexCommand: () => ({ command: 'codex', prefixArgs: [] }),
    resolveEnvironment: async () => ({ PATH: process.env.PATH }),
    ...scriptedCodexTransport(openConnection)
  })
  const attachParams = hostTestAttachParams(null, { providerHandle: undefined })
  attachParams.envelope.clientOperationId = operationId()
  const attached = await host.attach(CALLER, attachParams)
  if (!attached.ok) {
    throw new Error(JSON.stringify(attached.refusal))
  }
  fence = attached.value.fence
  statuses = []
  host.subscribeStatus({
    id: 'interrupt-order',
    emit: (event) => {
      if (event.type === 'status' && event.session.sessionId === SESSION) {
        statuses.push(event.session)
      }
    }
  })
})

afterEach(async () => {
  await stopStructuredAgentSessionRuntime()
  await rm(root, { recursive: true, force: true })
})

describe("a Codex Stop answered before Codex's turn/completed (interrupted)", () => {
  it.each([
    ['names the running turn', 'turn-1'],
    ['names no turn', undefined]
  ] as const)(
    'reads the turn as interrupted by the Stop, never failed, when it %s',
    async (_, named) => {
      await send('look around')
      await vi.waitFor(() => expect(answers).toBe(1))
      turns.start()

      await stop(named)

      await expectInterruptedThroughout()
    }
  )

  // A Stop accepted before turn/started must bind the turn that opens during settlement.
  it('reads the turn that opens behind an in-flight turn/start as interrupted, never failed', async () => {
    const release = turns.holdNextAnswer()
    await send('look around')
    await vi.waitFor(() => expect(answers).toBe(1))
    const stopping = stop()
    release()
    await stopping

    await expectInterruptedThroughout()
  })
})

// An answered interrupt has aborted its turn even before turn/completed; the next send must start a new turn.
describe('a send behind a Codex Stop answered before its turn ends', () => {
  it('opens its own turn with turn/start, never turn/steer', async () => {
    await send('look around')
    await vi.waitFor(() => expect(answers).toBe(1))
    turns.start()
    const answer = Promise.withResolvers<void>()
    interruptAnswer = answer.promise
    const stopping = stop()
    await vi.waitFor(() => expect(interrupts).toBe(1))

    // The session lane releases this send after Stop settles, while turn/completed is still pending.
    const sent = send('run this after the stop')
    await vi.waitFor(() => expect(statuses.some((summary) => summary.stopping === true)).toBe(true))
    expect(answers).toBe(1)
    answer.resolve()
    await stopping
    await sent

    await vi.waitFor(() => expect(answers).toBe(2))
    expect(steers).toBe(0)
    expect(startedTurns).toEqual(['turn-1', 'turn-2'])
    turns.end('interrupted')
    const clientMessageId = await sent
    const submission = (await host.journalSnapshot(SESSION)).submissions.find(
      (entry) => entry.clientMessageId === clientMessageId
    )
    expect(submission?.dispatchState).not.toBe('rejected')
  })
})
