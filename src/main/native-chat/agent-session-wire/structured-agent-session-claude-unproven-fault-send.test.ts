// A Claude child ended by an Orca fault whose close could not prove it gone, then the user's next
// messages, on the shipping adapter and host. The child may still be running, so the host keeps it
// and owes its stop: a message waits under the wind-down row, never reaching the old child and
// never written off as `unknown`, and goes out the moment the old child's exit is seen.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import type { AgentStatusStructuredSessionSubject } from '../../../shared/agent-status-subject'
import { AgentHookServer } from '../../agent-hooks/server'
import { ClaudeStructuredSessionAdapter } from '../../claude/claude-structured-session-adapter'
import {
  fakeClaude,
  PROVIDER_SESSION_ID,
  type FakeConnection
} from '../../claude/claude-structured-session-test-support'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import { structuredClaudeLifecycleEvent } from '../../runtime/structured-claude-runtime-adapter'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
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
const CAPABILITIES = ['interrupt_receipt_v1', 'interrupt_cancel_queued_v1', 'msg_lifecycle_v1']

let root: string
let host: StructuredAgentSessionHost
let adapter: ClaudeStructuredSessionAdapter
let store: AgentSessionRecordStore
let claude: ReturnType<typeof fakeClaude>
let server: AgentHookServer
let statusSubject: AgentStatusStructuredSessionSubject | undefined

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-claude-unproven-fault-send-'))
  resetHostTestOperationIds()
  server = new AgentHookServer()
  statusSubject = undefined
  claude = fakeClaude({
    replayUuid: null,
    routes: { interrupt: () => ({ still_queued: [], cancelled: [] }) }
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
    logger: recordingStructuredAgentSessionLogger().logger,
    idleSweep: { intervalMs: 1_000_000_000, idleMs: 0 },
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
  // Every child the test left unproven has exited by now.
  for (const connection of claude.connections) {
    connection.exitVerdict = { root: 'exited', tree: 'exited' }
  }
  await adapter.closeAll()
  await host.flushAllStreamedEvents()
  await rm(root, { recursive: true, force: true })
})

function eventually<T>(assertion: () => T | Promise<T>): Promise<T> {
  return vi.waitFor(assertion, { timeout: 10_000 })
}

function frame(connection: FakeConnection, message: Record<string, unknown>): void {
  connection.handlers.onMessage?.({ session_id: PROVIDER_SESSION_ID, ...message })
}

function wrote(connection: FakeConnection, text: string): boolean {
  return connection.sent.some((message) => JSON.stringify(message).includes(text))
}

function envelope(
  method: 'agentSession.send' | 'agentSession.cancel',
  fields: Parameters<typeof computeAgentSessionPayloadFingerprint>[0]['fields']
) {
  return {
    sessionId: SESSION,
    clientOperationId: hostTestOperationId(),
    expectedRuntimeFence: store.getRecord(SESSION)!.lease.runtimeFence,
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
    throw new Error(`send refused: ${JSON.stringify(sent.refusal)}`)
  }
  return sent.value.clientMessageId
}

function stop() {
  return host.cancel(CALLER, { envelope: envelope('agentSession.cancel', {}) })
}

async function submission(clientMessageId: string) {
  await host.flushStreamedEvents(SESSION)
  return (await host.journalSnapshot(SESSION)).submissions.find(
    (entry) => entry.clientMessageId === clientMessageId
  )
}

async function waitRows() {
  await host.flushStreamedEvents(SESSION)
  return (await host.journalSnapshot(SESSION)).items.filter(
    (item) => item.body.kind === 'status' && item.body.failure?.kind === 'previousExitUnverifiable'
  )
}

function laneDrained(): Promise<void> {
  return host['tasks'].serialize(SESSION, async () => {})
}

function hostSession() {
  return host['sessions'].get(SESSION)
}

function liveChildRecords() {
  const records = statusSubject ? server.getStructuredChildWorkViews(statusSubject) : []
  return records.filter((record) => record.membership === 'live')
}

/** The lead's turn ends with a background task still running, as a real Claude leaves it. */
async function turnWithBackgroundTask(connection: FakeConnection): Promise<void> {
  const text = 'Start a background agent.'
  await send(text)
  await eventually(() => expect(wrote(connection, text)).toBe(true))
  frame(connection, {
    type: 'system',
    subtype: 'init',
    uuid: 'init-1',
    model: 'claude-sonnet-5',
    capabilities: CAPABILITIES
  })
  const written = connection.sent.at(-1)!
  frame(connection, { ...written, uuid: written.uuid })
  frame(connection, {
    type: 'assistant',
    uuid: 'leaf-1',
    parent_tool_use_id: null,
    message: { id: 'msg-1', role: 'assistant', content: [{ type: 'text', text: 'Started.' }] }
  })
  frame(connection, {
    type: 'system',
    subtype: 'task_started',
    uuid: 'task-start',
    task_id: 'background-1',
    task_type: 'local_agent',
    is_backgrounded: true,
    description: 'bg agent'
  })
  frame(connection, { type: 'result', subtype: 'success', is_error: false, uuid: 'result-1' })
  await host.flushStreamedEvents(SESSION)
}

/** As a loaded machine leaves it: no close can prove the child gone; it still runs. */
function closesUnproven(connection: FakeConnection, pending?: Promise<void>): void {
  connection.exitVerdict = { root: 'live', tree: 'unverifiable' }
  connection.close = async () => {
    connection.closeCount += 1
    connection.closed = true
    if (connection.closeCount > 1) {
      await pending
    }
    return connection.exitVerdict.root === 'exited'
  }
}

/** The journal refuses a background-task row, and the adapter's own fault path ends the child. */
async function faultTheJournal(connection: FakeConnection): Promise<void> {
  const sink = host['runtimeState'].eventSinkFor(SESSION).sink
  vi.spyOn(sink, 'tryAppendResolvedItemAndPublish').mockReturnValueOnce({
    accepted: false,
    reason: 'failed'
  })
  frame(connection, {
    type: 'system',
    subtype: 'task_started',
    uuid: 'task-start-2',
    task_id: 'background-2',
    task_type: 'local_bash',
    is_backgrounded: true,
    description: 'npm run build'
  })
}

/** The old child's own exit, as the connection reports it once no close is watching. */
function exits(connection: FakeConnection): void {
  connection.exitVerdict = { root: 'exited', tree: 'exited' }
  connection.handlers.onExit?.(new Error('claude stream-json exited (code 0)'))
}

it('holds a message after a journal fault whose close was unproven, never sending it or leaving it unknown, and sends it once the old child exits', async () => {
  const connection = claude.connections[0]!
  await turnWithBackgroundTask(connection)
  closesUnproven(connection)
  await faultTheJournal(connection)
  await adapter.drainObservedExits()
  await laneDrained()
  const sentBefore = connection.sent.length

  const held = await send('Hello again after the fault.')
  await eventually(async () => {
    const state = (await submission(held))?.dispatchState
    expect(state === 'unknown' || (await waitRows()).length === 1).toBe(true)
  })
  await laneDrained()
  // Before: the dispatch threw on a child the adapter no longer held, and the send read `unknown`.
  expect((await submission(held))?.dispatchState).toBe('pending')
  expect((await submission(held))?.handedOverAt).toBeUndefined()
  expect(await waitRows()).toHaveLength(1)
  expect(connection.sent.length).toBe(sentBefore)
  // The child may still run: the host keeps it and owes its stop.
  expect(hostSession()?.child).toMatchObject({ phase: 'ready' })
  expect(hostSession()?.owesProviderChildWindDown?.failedAt).toBeDefined()
  const closesBeforeStop = connection.closeCount

  // Stop at rest withdraws the message and tries the kill again.
  await expect(stop()).resolves.toMatchObject({ ok: true, value: { cancelled: true } })
  expect(await submission(held)).toMatchObject({ dispatchState: 'rejected' })
  expect(connection.closeCount).toBe(closesBeforeStop + 1)
  expect(hostSession()?.owesProviderChildWindDown).toBeDefined()

  const next = await send('Carry on.')
  await eventually(() => expect(connection.closeCount).toBe(closesBeforeStop + 2))
  await laneDrained()
  expect(await submission(next)).toMatchObject({ dispatchState: 'pending' })
  expect(claude.connections).toHaveLength(1)

  // The old child exits: its owed stop lands at once, with no sweep tick, and the message goes out.
  exits(connection)
  const resumed = await eventually(() => {
    const started = claude.connections.at(-1)!
    expect(started).not.toBe(connection)
    expect(wrote(started, 'Carry on.')).toBe(true)
    return started
  })
  const echoed = resumed.sent.at(-1)!
  frame(resumed, { ...echoed, uuid: echoed.uuid })
  await eventually(async () => expect((await submission(next))?.dispatchState).toBe('accepted'))
  expect(wrote(connection, 'Carry on.')).toBe(false)
  expect(hostSession()?.owesProviderChildWindDown).toBeUndefined()
  // The old child's background work ended with it.
  expect(liveChildRecords().map((record) => record.providerId)).not.toContain('background-1')

  await expect(host['lifetime'].idleSweep.tick()).resolves.toBeUndefined()
})

it('rejects, never leaves in doubt, a message dispatched after the adapter let go of a child its close has not yet answered for', async () => {
  const connection = claude.connections[0]!
  await turnWithBackgroundTask(connection)
  const closing = Promise.withResolvers<void>()
  closesUnproven(connection, closing.promise)
  await faultTheJournal(connection)
  // The fault's first close gave up; the exit path's own close is still running.
  await eventually(() => expect(connection.closeCount).toBe(2))
  const sentBefore = connection.sent.length

  const raced = await send('Sent while the close runs.')
  await eventually(async () => expect((await submission(raced))?.dispatchState).not.toBe('pending'))
  expect(await submission(raced)).toMatchObject({
    dispatchState: 'rejected',
    rejection: { kind: 'hostFault' }
  })
  expect(connection.sent.length).toBe(sentBefore)

  closing.resolve()
  await adapter.drainObservedExits()
  await eventually(() => expect(hostSession()?.owesProviderChildWindDown).toBeDefined())
  expect(hostSession()?.child).toMatchObject({ phase: 'ready' })
})

it('owes the stop of a child a journal sink failure could not prove gone', async () => {
  const connection = claude.connections[0]!
  await turnWithBackgroundTask(connection)
  closesUnproven(connection)
  // The host's own recovery: the journal write fails for good, and Orca stops the provider.
  const journal = hostSession()!.journal
  vi.spyOn(journal, 'appendItem').mockRejectedValueOnce(new Error('disk unavailable'))
  frame(connection, {
    type: 'assistant',
    uuid: 'leaf-2',
    parent_tool_use_id: null,
    message: { id: 'msg-2', role: 'assistant', content: [{ type: 'text', text: 'Lost.' }] }
  })

  await eventually(() => expect(hostSession()?.owesProviderChildWindDown).toBeDefined())
  expect(hostSession()?.child).toMatchObject({ phase: 'ready' })
  expect(connection.closeCount).toBeGreaterThan(0)
  host['runtimeState'].eventSinkFor(SESSION)
})

/** A turn still running when the fault comes. */
async function turnRunning(connection: FakeConnection): Promise<void> {
  const text = 'Do a long thing.'
  await send(text)
  await eventually(() => expect(wrote(connection, text)).toBe(true))
  frame(connection, {
    type: 'system',
    subtype: 'init',
    uuid: 'init-1',
    model: 'claude-sonnet-5',
    capabilities: CAPABILITIES
  })
  const written = connection.sent.at(-1)!
  frame(connection, { ...written, uuid: written.uuid })
  frame(connection, {
    type: 'assistant',
    uuid: 'leaf-1',
    parent_tool_use_id: null,
    message: { id: 'msg-1', role: 'assistant', content: [{ type: 'text', text: 'Working...' }] }
  })
  await host.flushStreamedEvents(SESSION)
}

async function faultRows() {
  await host.flushStreamedEvents(SESSION)
  return (await host.journalSnapshot(SESSION)).items.flatMap((item) =>
    item.body.kind === 'status' && item.body.failure?.kind === 'hostFault' ? [item.body.text] : []
  )
}

it.each([
  ['proven at once', false],
  ['proven only by the late exit', true]
])('tells why a turn a journal fault cut short stopped, its close %s', async (_name, unproven) => {
  const connection = claude.connections[0]!
  await turnRunning(connection)
  if (unproven) {
    closesUnproven(connection)
  } else {
    connection.exitVerdict = { root: 'exited', tree: 'exited' }
  }
  await faultTheJournal(connection)
  await adapter.drainObservedExits()
  await laneDrained()
  if (unproven) {
    await eventually(() => expect(hostSession()?.owesProviderChildWindDown).toBeDefined())
    expect(await faultRows()).toEqual([])
    exits(connection)
  }
  await eventually(() => expect(hostSession()?.child).toBeNull())
  await eventually(() => expect(hostSession()?.owesProviderChildWindDown).toBeUndefined())

  // The same end reads the same however long its proof took.
  expect(await faultRows()).toEqual([
    "Orca ran into a problem, so this didn't go through. Try again."
  ])
  expect(hostSession()?.lastEndedChild).toMatchObject({
    cause: 'exit',
    failure: { kind: 'hostFault' }
  })
})

it("still tells why a turn a fault cut short stopped when the user's Stop comes before the late exit", async () => {
  const connection = claude.connections[0]!
  await turnRunning(connection)
  closesUnproven(connection)
  await faultTheJournal(connection)
  await adapter.drainObservedExits()
  await laneDrained()
  await eventually(() => expect(hostSession()?.owesProviderChildWindDown?.ended).toBeDefined())

  // The turn still reads running, so the user presses Stop; its close cannot prove the exit either.
  await expect(stop()).resolves.toMatchObject({ ok: true })
  await laneDrained()
  exits(connection)
  await eventually(() => expect(hostSession()?.child).toBeNull())
  await eventually(() => expect(hostSession()?.owesProviderChildWindDown).toBeUndefined())

  expect(await faultRows()).toEqual([
    "Orca ran into a problem, so this didn't go through. Try again."
  ])
  // The Stop stays the user's; the fault that came first says why the turn ended.
  expect(hostSession()?.lastEndedChild).toMatchObject({
    cause: 'user-stop',
    failure: { kind: 'hostFault' }
  })
})
