// A Stop ends Claude's child on the shipping adapter, whatever Claude answered the interrupt. The
// Stop answers on the interrupt; its next serialized step ends the child once Claude has wound down
// what it had in flight, or the grace runs out. The chat rests; the next send resumes it.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import { DISPATCH_REJECTED_CANCELLED } from '../../../shared/structured-agent-session-dispatch-rejection'
import { activeStructuredAgentSessionTurnId } from '../../../shared/structured-agent-session-live-turn'
import { projectStructuredAgentSessionStatusState } from '../../../shared/structured-agent-session-projection'
import { structuredAgentSessionAgentStatus } from '../../../shared/structured-agent-session-agent-status'
import type { AgentStatusStructuredSessionSubject } from '../../../shared/agent-status-subject'
import { AgentHookServer } from '../../agent-hooks/server'
import {
  ClaudeControlRequestError,
  runClaudeControl
} from '../../claude/claude-agent-sdk-control-requests'
import { CLAUDE_STOP_GRACE_MS } from '../../claude/claude-request-end-wait'
import { ClaudeStructuredSessionAdapter } from '../../claude/claude-structured-session-adapter'
import type { ClaudeStructuredSessionEvent } from '../../claude/claude-structured-session-state'
import {
  fakeClaude,
  PROVIDER_SESSION_ID,
  type FakeConnection
} from '../../claude/claude-structured-session-test-support'
import { invokeCanUseTool } from '../../claude/claude-can-use-tool-test-support'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import { structuredClaudeLifecycleEvent } from '../../runtime/structured-claude-runtime-adapter'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import { createStoppedClaudeDeadline } from './structured-agent-session-stop-deadline.test-fixture'
import { recordingStructuredAgentSessionLogger } from './structured-agent-session-logger-test-support'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  hostTestAttachParams,
  hostTestMessage,
  hostTestOperationId,
  resetHostTestOperationIds
} from './structured-agent-session-host-test-data'

const CALLER = { callerKey: 'client-1' }
// As Claude Code 2.1.280 advertises them on a turn's system/init frame.
const CAPABILITIES = ['interrupt_receipt_v1', 'interrupt_cancel_queued_v1', 'msg_lifecycle_v1']

let root: string
let host: StructuredAgentSessionHost
let adapter: ClaudeStructuredSessionAdapter
let store: AgentSessionRecordStore
let queued: string[]
let claude: ReturnType<typeof fakeClaude>
let events: ClaudeStructuredSessionEvent[]
let logs: ReturnType<typeof recordingStructuredAgentSessionLogger>
// The host's status row and child records, as the app's hook server holds them.
let server: AgentHookServer
let statusSubject: AgentStatusStructuredSessionSubject | undefined

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-claude-stop-ends-session-'))
  resetHostTestOperationIds()
  queued = []
  events = []
  logs = recordingStructuredAgentSessionLogger()
  server = new AgentHookServer()
  statusSubject = undefined
  claude = fakeClaude({
    replayUuid: null,
    routes: {
      interrupt: (params) =>
        params?.cancelQueued
          ? { still_queued: [], cancelled: queued.splice(0) }
          : { still_queued: [...queued] }
    }
  })
  const lifecycle: Promise<void>[] = []
  adapter = new ClaudeStructuredSessionAdapter({
    resolveLaunch: async () => ({
      pathToClaudeCodeExecutable: 'claude',
      options: {},
      cwd: root,
      claudeConfigDir: join(root, 'claude-home'),
      providerSessionId: PROVIDER_SESSION_ID,
      resumeLeafUuid: null,
      resumesTranscript: (store.getRecord(SESSION)?.providerHandleChain.length ?? 0) > 0,
      continuesChain: (store.getRecord(SESSION)?.providerHandleChain.length ?? 0) > 0
    }),
    onEvent: (event) => {
      events.push(event)
      const mapped = structuredClaudeLifecycleEvent(event)
      if (mapped) {
        lifecycle.push(host.handleAdapterEvent(mapped))
      }
    },
    onDispatchSettledLate: (settlement) => void host.settleLateDispatch(settlement),
    onChildWorkEvidence: (sessionId, evidence) =>
      host.publishChildWorkEvidence(sessionId, evidence),
    openConnection: claude.openConnection,
    readProcessStartTime: async () => 1_700_000_000_000,
    now: () => NOW
  })
  store = await openTestAgentSessionRecordStore(root)
  host = new StructuredAgentSessionHost({
    store,
    adapter: Object.assign(adapter, { supportsCreate: () => true }),
    journalDatabase: openTestJournalHostDatabase(root),
    claimKeyId: 'key-1',
    mintSpawnToken: () => 'spawn-a',
    logger: logs.logger,
    statusSink: {
      publish: (summary, subject) => {
        statusSubject = subject
        server.ingestStructuredStatus(summary, subject)
      },
      forget: (subject) => server.dropStructuredStatus(subject),
      publishChildWork: (subject, evidence, provider) =>
        server.ingestStructuredChildWork(subject, evidence, provider),
      readChildWork: (subject) => server.getStructuredChildWorkViews(subject)
    },
    now: () => NOW
  })
  const params = hostTestAttachParams(null, {
    provider: 'claude',
    agent: 'claude',
    accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: join(root, 'claude-home') },
    providerHandle: { kind: 'claude', sessionId: PROVIDER_SESSION_ID, leafUuid: null }
  })
  expect(await host.attach(CALLER, params)).toMatchObject({ ok: true })
  await adapter.awaitStarted(SESSION)
  await Promise.all(lifecycle)
})

afterEach(async () => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  await adapter.closeAll()
  await host.flushAllStreamedEvents()
  await rm(root, { recursive: true, force: true })
})

function eventually<T>(assertion: () => T | Promise<T>): Promise<T> {
  return vi.waitFor(assertion, { timeout: 10_000 })
}

function envelope(
  method: 'agentSession.send' | 'agentSession.cancel',
  fields: Record<string, unknown>,
  fence = store.getRecord(SESSION)!.lease.runtimeFence
) {
  return {
    sessionId: SESSION,
    clientOperationId: hostTestOperationId(),
    expectedRuntimeFence: fence,
    payloadFingerprint: computeAgentSessionPayloadFingerprint({
      method,
      sessionId: SESSION,
      fields
    })
  }
}

async function send(text: string, fence?: number): Promise<string> {
  const body = hostTestMessage(text)
  const sent = await host.send(CALLER, {
    envelope: envelope('agentSession.send', { body }, fence),
    body
  })
  if (!sent.ok) {
    throw new Error('send refused')
  }
  return sent.value.clientMessageId
}

async function dispatch(clientMessageId: string) {
  const submission = (await host.journalSnapshot(SESSION)).submissions.find(
    (entry) => entry.clientMessageId === clientMessageId
  )
  return { state: submission?.dispatchState, reason: submission?.reason }
}

function frame(connection: FakeConnection, message: Record<string, unknown>): void {
  connection.handlers.onMessage?.({ session_id: PROVIDER_SESSION_ID, ...message })
}

/** Sends a message and lets Claude open its turn and write one reply; returns the turn's id. */
async function openTurn(connection: FakeConnection, text = 'Write a long reply.'): Promise<string> {
  const clientMessageId = await send(text)
  await eventually(() =>
    expect(connection.sent.some((message) => JSON.stringify(message).includes(text))).toBe(true)
  )
  frame(connection, {
    type: 'system',
    subtype: 'init',
    uuid: `init-${text}`,
    model: 'claude-sonnet-5',
    capabilities: CAPABILITIES
  })
  const written = connection.sent.at(-1)!
  frame(connection, { ...written, uuid: written.uuid })
  frame(connection, {
    type: 'assistant',
    uuid: 'stopped-turn-leaf',
    parent_tool_use_id: null,
    message: { id: 'msg-1', role: 'assistant', content: [{ type: 'text', text: 'Working on' }] }
  })
  await eventually(async () => expect((await dispatch(clientMessageId)).state).toBe('accepted'))
  const turnId = activeStructuredAgentSessionTurnId((await host.journalSnapshot(SESSION)).items)
  expect(turnId).not.toBeNull()
  return turnId!
}

function stop(turnId?: string) {
  const fields = turnId === undefined ? {} : { turnId }
  return host.cancel(CALLER, { envelope: envelope('agentSession.cancel', fields), ...fields })
}

/** Resolves once everything queued on the session's lane so far has run: a Stop's second step. */
const laneDrained = (): Promise<void> => host['tasks'].serialize(SESSION, async () => {})

const stopAcrossGrace = createStoppedClaudeDeadline({
  host: () => host,
  adapter: () => adapter,
  claude: () => claude,
  sessionId: SESSION,
  stop,
  laneDrained
})

/** How many person's Stop events the journal holds when the child's close begins. */
function stopEventsAtClose(connection: FakeConnection): () => number | undefined {
  let atClose: number | undefined
  const close = connection.close
  connection.close = async () => {
    const journal = host.collaboratorsForTests().sessions.get(SESSION)?.journal
    const since = journal?.readSince({ epoch: journal.epoch, sequence: 0 })
    atClose ??= since?.ok
      ? since.rows.filter(
          (row) => row.kind === 'tombstone' && row.stopEvent?.reason === 'user-stop'
        ).length
      : -1
    return close()
  }
  return () => atClose
}

function wrote(connection: FakeConnection, text: string): boolean {
  return connection.sent.some((message) => JSON.stringify(message).includes(text))
}

const INTERRUPTED_RESULT = {
  type: 'result',
  subtype: 'error_during_execution',
  is_error: true,
  terminal_reason: 'aborted_streaming',
  uuid: 'interrupted-result'
}

// As the real control surface runs it: no answer ever comes, only the deadline Orca sets.
const NEVER_ANSWERS = (options?: Record<string, unknown>) =>
  runClaudeControl(
    'interrupt',
    () => new Promise(() => {}),
    typeof options?.timeoutMs === 'number' ? options.timeoutMs : undefined
  )

async function interruptSent(connection: FakeConnection): Promise<void> {
  await eventually(() =>
    expect(connection.calls.some((call) => call.subtype === 'interrupt')).toBe(true)
  )
}

async function turnOutcome(): Promise<string | undefined> {
  await host.flushStreamedEvents(SESSION)
  const snapshot = await host.journalSnapshot(SESSION)
  return readAgentJournalTurn(snapshot.items.findLast((item) => item.body.kind === 'turn')?.body)
    ?.outcome
}

async function statusTexts(): Promise<string[]> {
  await host.flushStreamedEvents(SESSION)
  return (await host.journalSnapshot(SESSION)).items.flatMap((item) =>
    item.body.kind === 'status' ? [String(item.body.text)] : []
  )
}

it('answers on the interrupt, ends the child once the stopped turn ends, and rests at that turn', async () => {
  const connection = claude.connections[0]!
  const eventsAtClose = stopEventsAtClose(connection)
  await openTurn(connection)

  await expect(stop()).resolves.toMatchObject({ ok: true, value: { cancelled: true } })
  // The Stop answered on the interrupt Claude took: the child waits for Claude to end the turn.
  expect(connection.closed).toBe(false)
  expect(await statusTexts()).toEqual(['Cancellation requested.'])
  const ended = Date.now()
  frame(connection, INTERRUPTED_RESULT)
  await laneDrained()
  // The turn's own end releases the wait; the grace is not waited out.
  expect(Date.now() - ended).toBeLessThan(CLAUDE_STOP_GRACE_MS / 2)

  expect(connection.closed).toBe(true)
  expect(eventsAtClose()).toBe(1)
  expect(store.getRecord(SESSION)?.lease.claimStatus).toBe('released')
  expect(await turnOutcome()).toBe('cancellation')
  // The resume point is the stopped turn's own, so the next send continues after it.
  expect(events.findLast((event) => event.type === 'handle')).toMatchObject({
    type: 'handle',
    providerSessionId: PROVIDER_SESSION_ID,
    leafUuid: 'stopped-turn-leaf'
  })
})

/** Sends a message Claude takes but has not echoed yet: no turn row, the chat still working. */
async function sendUnechoed(connection: FakeConnection): Promise<string> {
  const clientMessageId = await send('Write a long reply.')
  await eventually(() => expect(wrote(connection, 'Write a long reply.')).toBe(true))
  return clientMessageId
}

function childRecords() {
  return statusSubject ? server.getStructuredChildWorkViews(statusSubject) : []
}

async function agentStatus() {
  await host.flushStreamedEvents(SESSION)
  const { items, submissions } = await host.journalSnapshot(SESSION)
  const { summary } = projectStructuredAgentSessionStatusState(
    items,
    submissions,
    store.getRecord(SESSION)!.lease.runtimeFence
  )
  return summary.status
    ? structuredAgentSessionAgentStatus({
        status: summary.status,
        turnOutcome: summary.turnOutcome,
        childWork: childRecords()
      })
    : null
}

it('reads a Stop pressed before Claude echoed the send as interrupted, not as a finished turn', async () => {
  const connection = claude.connections[0]!
  // As Claude winds down a request interrupted before its echo: echo, marker, aborted result, idle.
  claude.routes.interrupt = () => {
    setTimeout(() => {
      const written = connection.sent.find((message) => message.type === 'user')!
      frame(connection, { ...written, uuid: written.uuid })
      frame(connection, {
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'text', text: '[Request interrupted by user]' }]
        },
        parent_tool_use_id: null,
        uuid: 'interrupted-marker'
      })
      frame(connection, INTERRUPTED_RESULT)
      frame(connection, { type: 'system', subtype: 'session_state_changed', state: 'idle' })
    }, 5)
    return { still_queued: [], cancelled: [] }
  }
  const clientMessageId = await sendUnechoed(connection)

  await expect(stop()).resolves.toMatchObject({ ok: true, value: { cancelled: true } })
  await laneDrained()

  expect(connection.closed).toBe(true)
  expect(await dispatch(clientMessageId)).toMatchObject({ state: 'accepted' })
  expect(await turnOutcome()).toBe('cancellation')
  expect(await agentStatus()).toMatchObject({ mainAgent: { outcome: 'cancellation' } })
})

it('ends the child once the grace runs out when Claude says nothing after a Stop before the echo', async () => {
  const connection = claude.connections[0]!
  const eventsAtClose = stopEventsAtClose(connection)
  claude.routes.interrupt = () => ({ still_queued: [], cancelled: [] })
  const clientMessageId = await sendUnechoed(connection)

  await expect(stopAcrossGrace(connection, 'request-end')).resolves.toMatchObject({
    ok: true,
    value: { cancelled: true }
  })
  await laneDrained()

  // As before the wait: the send Claude never answered is doubt once its child ends.
  expect(connection.closed).toBe(true)
  expect(eventsAtClose()).toBe(1)
  expect(await dispatch(clientMessageId)).toMatchObject({ state: 'unknown' })
}, 15_000)

it('withdraws a follow-up Claude queued behind the turn before the child ends, never doubt', async () => {
  const connection = claude.connections[0]!
  await openTurn(connection)
  const followUp = await send('And then this.')
  await eventually(() => expect(connection.sent.at(-1)?.message).toBeDefined())
  queued.push(String(connection.sent.at(-1)!.uuid))
  await eventually(async () => expect((await dispatch(followUp)).state).toBe('pending'))

  await expect(stop()).resolves.toMatchObject({ ok: true, value: { cancelled: true } })

  // Withdrawn by Claude's own receipt while the child still runs, so it is never re-sent and never
  // read as delivered.
  expect(connection.closed).toBe(false)
  expect(await dispatch(followUp)).toEqual({
    state: 'rejected',
    reason: DISPATCH_REJECTED_CANCELLED
  })
  frame(connection, INTERRUPTED_RESULT)
  await laneDrained()
  expect(connection.closed).toBe(true)
})

it('ends the child at once when Claude refuses the interrupt, and says only that the stop was asked', async () => {
  claude.routes.interrupt = () => {
    throw new ClaudeControlRequestError('interrupt', 'Claude did not answer the interrupt.')
  }
  const connection = claude.connections[0]!
  const eventsAtClose = stopEventsAtClose(connection)
  await openTurn(connection)

  const asked = Date.now()
  await expect(stop()).resolves.toMatchObject({ ok: true, value: { cancelled: true } })
  await laneDrained()
  // A turn Claude would not interrupt ends only with its child, so there is no grace to wait.
  expect(Date.now() - asked).toBeLessThan(CLAUDE_STOP_GRACE_MS / 2)

  expect(connection.closed).toBe(true)
  expect(eventsAtClose()).toBe(1)
  expect(await turnOutcome()).toBe('cancellation')
  const texts = await statusTexts()
  expect(texts).toContain('Cancellation requested.')
  expect(texts.some((text) => text.includes("didn't stop"))).toBe(false)
})

it('ends the child when the interrupt fails, with no unconfirmed row', async () => {
  claude.routes.interrupt = () => {
    throw new Error('control request lost')
  }
  const connection = claude.connections[0]!
  const eventsAtClose = stopEventsAtClose(connection)
  await openTurn(connection)

  await expect(stop()).resolves.toMatchObject({ ok: true, value: { cancelled: true } })
  await laneDrained()

  expect(connection.closed).toBe(true)
  expect(eventsAtClose()).toBe(1)
  expect(await turnOutcome()).toBe('cancellation')
  expect(await statusTexts()).toEqual(['Cancellation requested.'])
})

it('ends the child within the grace when Claude never answers the interrupt', async () => {
  claude.routes.interrupt = NEVER_ANSWERS
  const connection = claude.connections[0]!
  const eventsAtClose = stopEventsAtClose(connection)
  await openTurn(connection)

  await expect(stopAcrossGrace(connection, 'interrupt')).resolves.toMatchObject({
    ok: true,
    value: { cancelled: true }
  })
  await laneDrained()

  expect(connection.closed).toBe(true)
  expect(eventsAtClose()).toBe(1)
  expect(await turnOutcome()).toBe('cancellation')
  expect(await statusTexts()).toEqual(['Cancellation requested.'])
}, 15_000)

it('ends background work Claude runs when the Stop ends the child', async () => {
  const connection = claude.connections[0]!
  await openTurn(connection)
  frame(connection, {
    type: 'system',
    subtype: 'task_started',
    uuid: 'task-start',
    task_id: 'background-1',
    task_type: 'local_agent',
    is_backgrounded: true
  })
  const background = { providerId: 'background-1', kind: 'agent' }
  // The host's child record, which the strip, the sidebar and Monitoring all read.
  expect(childRecords()).toEqual([
    expect.objectContaining({ ...background, state: 'working', membership: 'live' })
  ])

  await expect(stop()).resolves.toMatchObject({ ok: true, value: { cancelled: true } })
  frame(connection, INTERRUPTED_RESULT)
  await laneDrained()
  // The work ran inside Claude's process, so it ends with it: its record settles, and the chat
  // reads done, Interrupted, with nothing left for Monitoring.
  expect(childRecords()).toEqual([
    expect.objectContaining({
      ...background,
      state: 'done',
      membership: 'settled',
      // Stopped with the chat, as a task's own stop reads: Interrupted, not an unknown ending.
      outcome: 'cancelled'
    })
  ])
  expect(await agentStatus()).toEqual({
    state: 'done',
    mainAgent: { state: 'done', outcome: 'cancellation' }
  })
  expect(connection.closed).toBe(true)
})

it('starts a new child for the next send after a Stop, on the same Claude conversation', async () => {
  const connection = claude.connections[0]!
  await openTurn(connection)
  await stop()
  frame(connection, INTERRUPTED_RESULT)
  await laneDrained()

  const next = await send('Carry on.')
  const resumed = await eventually(() => {
    const started = claude.connections.at(-1)
    expect(started).not.toBe(connection)
    expect(started && wrote(started, 'Carry on.')).toBe(true)
    return started!
  })
  // The wake resumes the same Claude conversation; the first test pins the leaf it resumes after.
  expect(store.getRecord(SESSION)?.providerHandleChain.at(-1)?.handle).toMatchObject({
    sessionId: PROVIDER_SESSION_ID
  })
  expect(resumed.closed).toBe(false)
  expect(await dispatch(next)).toMatchObject({ state: 'pending' })
})

it('delivers a send issued with the pre-Stop fence during the Stop to the resumed child only', async () => {
  const connection = claude.connections[0]!
  await openTurn(connection)
  const fence = store.getRecord(SESSION)!.lease.runtimeFence
  let childrenWhenClosed: number | undefined
  const close = connection.close
  connection.close = async () => {
    const proven = await close()
    childrenWhenClosed = claude.connections.length
    return proven
  }

  let answer!: () => void
  claude.routes.interrupt = () =>
    new Promise((resolve) => {
      answer = () => resolve({ still_queued: [], cancelled: [] })
    })

  // Issued while the Stop's first step waits on the interrupt: the client still holds the fence
  // the rest moves.
  const stopped = stop()
  await interruptSent(connection)
  const sent = send('Typed during the Stop.', fence)
  answer()
  expect(await stopped).toMatchObject({ ok: true, value: { cancelled: true } })
  frame(connection, INTERRUPTED_RESULT)

  await expect(sent).resolves.toEqual(expect.any(String))
  const resumed = await eventually(() => {
    const started = claude.connections.at(-1)!
    expect(started).not.toBe(connection)
    expect(wrote(started, 'Typed during the Stop.')).toBe(true)
    return started
  })
  // Handed over only after the old child's close resolved, and never to that child.
  expect(childrenWhenClosed).toBe(1)
  expect(resumed.closed).toBe(false)
  expect(wrote(connection, 'Typed during the Stop.')).toBe(false)
  expect(store.getRecord(SESSION)!.lease.runtimeFence).not.toBe(fence)
  expect((await statusTexts()).filter((text) => text !== 'Cancellation requested.')).toEqual([])
})

it('sends a queue-if-active message issued while the Stop ends the child directly to the resumed child', async () => {
  const connection = claude.connections[0]!
  await openTurn(connection)
  const fence = store.getRecord(SESSION)!.lease.runtimeFence
  let childrenWhenClosed: number | undefined
  const close = connection.close
  connection.close = async () => {
    const proven = await close()
    childrenWhenClosed = claude.connections.length
    return proven
  }

  await expect(stop()).resolves.toMatchObject({ ok: true, value: { cancelled: true } })
  // Issued while the Stop's second step waits for the stopped turn, with the fence it moves.
  const body = hostTestMessage('Queued during the Stop.')
  const sent = host.send(CALLER, {
    envelope: envelope('agentSession.send', { body, delivery: 'queue-if-active' }, fence),
    body,
    delivery: 'queue-if-active',
    userSend: true
  })
  frame(connection, INTERRUPTED_RESULT)

  // Nothing runs after the rest, so it goes out as a direct submission, not a queued card.
  expect(await sent).toMatchObject({ ok: true, value: { submission: expect.any(Object) } })
  await eventually(() => {
    const started = claude.connections.at(-1)!
    expect(started).not.toBe(connection)
    expect(wrote(started, 'Queued during the Stop.')).toBe(true)
  })
  expect(childrenWhenClosed).toBe(1)
  expect(wrote(connection, 'Queued during the Stop.')).toBe(false)
})

it("runs nothing queued during the Stop's first step before the child's end", async () => {
  const connection = claude.connections[0]!
  await openTurn(connection)
  let answer!: () => void
  claude.routes.interrupt = () =>
    new Promise((resolve) => {
      answer = () => resolve({ still_queued: [], cancelled: [] })
    })

  const stopped = stop()
  await interruptSent(connection)
  // Any later operation on the chat, such as a prompt answer or an option change, queues here.
  let childLiveForNextOperation: boolean | undefined
  const next = host['tasks'].serialize(SESSION, async () => {
    childLiveForNextOperation = !connection.closed
  })
  answer()
  await stopped
  frame(connection, INTERRUPTED_RESULT)
  await next

  expect(childLiveForNextOperation).toBe(false)
})

it('still answers the Stop, with its row, when the child cannot be proven gone; the failure is reported', async () => {
  const connection = claude.connections[0]!
  await openTurn(connection)
  const close = connection.close
  connection.close = async () => false

  await expect(stop()).resolves.toMatchObject({ ok: true, value: { cancelled: true } })
  frame(connection, INTERRUPTED_RESULT)
  await laneDrained()

  expect(await statusTexts()).toEqual(['Cancellation requested.'])
  expect(logs.entries).toEqual([
    expect.objectContaining({
      fields: expect.objectContaining({
        scope: 'chat-stop',
        error: expect.objectContaining({
          name: 'StructuredAgentSessionEvictionError',
          step: 'stop-provider-child'
        })
      })
    })
  ])
  connection.close = close
})

it.each([
  ['takes', undefined],
  [
    'fails',
    () => {
      throw new Error('control request lost')
    }
  ],
  ['never answers', NEVER_ANSWERS]
])(
  'ends the child for a Stop naming the turn that just ended when Claude interrupts the follow-up and %s',
  async (_answer, interrupt) => {
    if (interrupt) {
      claude.routes.interrupt = interrupt
    }
    const connection = claude.connections[0]!
    const eventsAtClose = stopEventsAtClose(connection)
    const ended = await openTurn(connection)
    frame(connection, { type: 'result', subtype: 'success', is_error: false, uuid: 'result-1' })
    await eventually(async () =>
      expect(
        activeStructuredAgentSessionTurnId((await host.journalSnapshot(SESSION)).items)
      ).toBeNull()
    )
    // Handed over but not yet echoed: no turn of its own for a client to name.
    await send('Follow-up.')
    await eventually(() => expect(wrote(connection, 'Follow-up.')).toBe(true))

    // As the phone sends it: the turn it last saw working.
    await expect(
      _answer === 'fails'
        ? stop(ended)
        : stopAcrossGrace(
            connection,
            interrupt === NEVER_ANSWERS ? 'interrupt' : 'request-end',
            ended
          )
    ).resolves.toMatchObject({ ok: true, value: { cancelled: true } })
    await laneDrained()

    expect(connection.calls.some((call) => call.subtype === 'interrupt')).toBe(true)
    expect(connection.closed).toBe(true)
    expect(eventsAtClose()).toBe(1)
    expect(await statusTexts()).toEqual(['Cancellation requested.'])
  },
  15_000
)

it('keeps a second Stop pressed while the first ends the child quiet', async () => {
  const connection = claude.connections[0]!
  await openTurn(connection)

  await expect(stop()).resolves.toMatchObject({ ok: true, value: { cancelled: true } })
  const second = stop()
  frame(connection, INTERRUPTED_RESULT)

  await expect(second).resolves.toMatchObject({ ok: true, value: { cancelled: false } })
  expect(connection.closed).toBe(true)
  expect(connection.calls.filter((call) => call.subtype === 'interrupt')).toHaveLength(1)
  expect(await statusTexts()).toEqual(['Cancellation requested.'])
  expect(logs.entries).toEqual([])
})

const BRANCH_QUESTION = {
  questions: [
    {
      question: 'Which branch?',
      header: 'Branch',
      multiSelect: false,
      options: [{ label: 'main' }, { label: 'dev' }]
    }
  ]
}

/** Claude asks on the open turn; returns its answer and the card the journal shows for it. */
async function ask(
  connection: FakeConnection,
  toolName: string,
  input: Record<string, unknown>,
  signal?: AbortSignal
): Promise<{
  answered: ReturnType<typeof invokeCanUseTool>
  card: { itemId: string; expectedRevision: number }
}> {
  const answered = invokeCanUseTool(connection, toolName, 'permission-1', 'tool-1', {
    input,
    ...(signal ? { signal } : {})
  })
  const card = await eventually(async () => {
    await host.flushStreamedEvents(SESSION)
    const item = (await host.journalSnapshot(SESSION)).items.find(
      (entry) => entry.body.kind === 'approval' || entry.body.kind === 'question'
    )
    expect(item).toBeDefined()
    return { itemId: item!.itemId, expectedRevision: item!.revision }
  })
  return { answered, card }
}

function cancelCard(turnId: string, prompt: { itemId: string; expectedRevision: number }) {
  const fields = { turnId, prompt }
  return host.cancel(CALLER, { envelope: envelope('agentSession.cancel', fields), ...fields })
}

async function cardResolution(itemId: string): Promise<unknown> {
  await host.flushStreamedEvents(SESSION)
  const body = (await host.journalSnapshot(SESSION)).items.find(
    (item) => item.itemId === itemId
  )?.body
  return body?.kind === 'approval' || body?.kind === 'question' ? body.resolution : undefined
}

it('dismisses an approval card on its Cancel with the Deny reply, and the turn and child go on', async () => {
  const connection = claude.connections[0]!
  const turnId = await openTurn(connection)
  const { answered, card } = await ask(connection, 'Bash', { command: 'rm -rf build' })

  await expect(cancelCard(turnId, card)).resolves.toMatchObject({
    ok: true,
    value: { turnId, cancelled: true }
  })
  await laneDrained()

  const reply = await answered.promise
  expect(reply).toMatchObject({ behavior: 'deny', message: 'User denied this action.' })
  expect(reply).not.toHaveProperty('interrupt')
  // Read as cancelled by the user, as every card's Cancel reads, not as a Deny pressed.
  expect(await cardResolution(card.itemId)).toMatchObject({
    state: 'cancelled',
    resolvedBy: CALLER.callerKey
  })
  expect(connection.calls.some((call) => call.subtype === 'interrupt')).toBe(false)
  expect(connection.closed).toBe(false)
  expect(activeStructuredAgentSessionTurnId((await host.journalSnapshot(SESSION)).items)).toBe(
    turnId
  )
  expect(await statusTexts()).toEqual([])
})

it("ends a question card's Cancel the way the chat's Stop does, and the next send resumes", async () => {
  const connection = claude.connections[0]!
  const eventsAtClose = stopEventsAtClose(connection)
  const turnId = await openTurn(connection)
  const request = new AbortController()
  const { answered, card } = await ask(
    connection,
    'AskUserQuestion',
    BRANCH_QUESTION,
    request.signal
  )

  await expect(cancelCard(turnId, card)).resolves.toMatchObject({
    ok: true,
    value: { turnId, cancelled: true }
  })
  // As Claude does once interrupted: it cancels the request it was holding.
  request.abort()
  await host.flushStreamedEvents(SESSION)
  // Settled with the Stop's first step, before the child ends: not answerable meanwhile.
  expect(connection.closed).toBe(false)
  const cancelledHere = { state: 'cancelled', resolvedBy: CALLER.callerKey }
  expect(await cardResolution(card.itemId)).toMatchObject(cancelledHere)
  expect(connection.calls.some((call) => call.subtype === 'interrupt')).toBe(true)
  frame(connection, INTERRUPTED_RESULT)
  await laneDrained()

  expect(connection.closed).toBe(true)
  expect(eventsAtClose()).toBe(1)
  expect(await turnOutcome()).toBe('cancellation')
  // The child's end takes Claude's request with it: no reply raced the interrupt, and nothing
  // wrote over the user's cancel.
  expect(await answered.promise).not.toMatchObject({ behavior: expect.any(String) })
  expect(await cardResolution(card.itemId)).toMatchObject(cancelledHere)
  expect(await statusTexts()).toEqual(['Cancellation requested.'])
  await send('Carry on.')
  await eventually(() => {
    const started = claude.connections.at(-1)!
    expect(started).not.toBe(connection)
    expect(wrote(started, 'Carry on.')).toBe(true)
  })
})

it("declines a question card's Cancel itself when the Stop finds nothing to stop", async () => {
  const connection = claude.connections[0]!
  const ended = await openTurn(connection)
  frame(connection, { type: 'result', subtype: 'success', is_error: false, uuid: 'result-1' })
  await eventually(async () =>
    expect(
      activeStructuredAgentSessionTurnId((await host.journalSnapshot(SESSION)).items)
    ).toBeNull()
  )
  // Asked after the main turn ended, as a background agent might.
  const { answered, card } = await ask(connection, 'AskUserQuestion', BRANCH_QUESTION)

  await expect(cancelCard(ended, card)).resolves.toMatchObject({ ok: true })
  await laneDrained()

  expect(await answered.promise).toMatchObject({
    behavior: 'deny',
    message: expect.stringMatching(/dismissed/)
  })
  expect(await cardResolution(card.itemId)).toMatchObject({
    state: 'cancelled',
    resolvedBy: CALLER.callerKey
  })
  expect(connection.calls.some((call) => call.subtype === 'interrupt')).toBe(false)
  expect(connection.closed).toBe(false)
  expect(await statusTexts()).toEqual([])
})

it('dismisses a question card a finished turn raised, leaving the turn running now alone', async () => {
  const connection = claude.connections[0]!
  const earlier = await openTurn(connection)
  // Asked in the first turn, then outlived it, as a background agent's question might.
  const { answered, card } = await ask(connection, 'AskUserQuestion', BRANCH_QUESTION)
  frame(connection, { type: 'result', subtype: 'success', is_error: false, uuid: 'result-1' })
  await eventually(async () =>
    expect(
      activeStructuredAgentSessionTurnId((await host.journalSnapshot(SESSION)).items)
    ).toBeNull()
  )
  const running = await openTurn(connection, 'Now something else.')
  expect(running).not.toBe(earlier)

  await expect(cancelCard(earlier, card)).resolves.toMatchObject({ ok: true })
  await laneDrained()

  expect(await answered.promise).toMatchObject({ behavior: 'deny' })
  expect(await cardResolution(card.itemId)).toMatchObject({
    state: 'cancelled',
    resolvedBy: CALLER.callerKey
  })
  expect(connection.calls.some((call) => call.subtype === 'interrupt')).toBe(false)
  expect(connection.closed).toBe(false)
  expect(activeStructuredAgentSessionTurnId((await host.journalSnapshot(SESSION)).items)).toBe(
    running
  )
})

it('dismisses a plan card on its Cancel: Claude is told to wait for the user, and keeps running', async () => {
  const connection = claude.connections[0]!
  const turnId = await openTurn(connection)
  const { answered, card } = await ask(connection, 'ExitPlanMode', {
    plan: '# Release\n\n- Tag it'
  })

  await expect(cancelCard(turnId, card)).resolves.toMatchObject({
    ok: true,
    value: { turnId, cancelled: true }
  })
  await laneDrained()

  const reply = await answered.promise
  expect(reply).toMatchObject({ behavior: 'deny' })
  expect(reply).not.toHaveProperty('interrupt')
  // Not "keep planning": nothing asks Claude to revise and show another plan.
  expect(JSON.stringify(reply)).toMatch(/wait for them/)
  expect(JSON.stringify(reply)).not.toMatch(/keep planning|ExitPlanMode again/i)
  expect(connection.calls.some((call) => call.subtype === 'interrupt')).toBe(false)
  expect(connection.closed).toBe(false)
  const cards = (await host.journalSnapshot(SESSION)).items.filter(
    (item) => item.body.kind === 'approval'
  )
  expect(cards).toHaveLength(1)
  expect(await cardResolution(card.itemId)).toMatchObject({
    state: 'cancelled',
    resolvedBy: CALLER.callerKey
  })
  expect(await statusTexts()).toEqual([])
})
