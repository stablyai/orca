// A Claude Stop whose close could not prove the child gone, then the user's next message, on the
// shipping adapter and host. That child takes no input, so the send retries the stop first; still
// unproven, the message waits with its reason until a later retry proves the exit.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import { activeStructuredAgentSessionTurnId } from '../../../shared/structured-agent-session-live-turn'
import { claudeUnwrittenUserMessageError } from '../../claude/claude-agent-sdk-user-message-queue'
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
let log: ReturnType<typeof recordingStructuredAgentSessionLogger>

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-claude-unproven-stop-send-'))
  resetHostTestOperationIds()
  log = recordingStructuredAgentSessionLogger()
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
    logger: log.logger,
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
  await adapter.closeAll()
  await host.flushAllStreamedEvents()
  await rm(root, { recursive: true, force: true })
})

function eventually<T>(assertion: () => T | Promise<T>): Promise<T> {
  return vi.waitFor(assertion, { timeout: 10_000 })
}

function envelope(
  method:
    | 'agentSession.send'
    | 'agentSession.cancel'
    | 'agentSession.setOption'
    | 'agentSession.queuedMessageSend',
  // The fingerprint's own field shape, as the sibling host tests type it.
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

async function submission(clientMessageId: string) {
  await host.flushStreamedEvents(SESSION)
  return (await host.journalSnapshot(SESSION)).submissions.find(
    (entry) => entry.clientMessageId === clientMessageId
  )
}

function frame(connection: FakeConnection, message: Record<string, unknown>): void {
  connection.handlers.onMessage?.({ session_id: PROVIDER_SESSION_ID, ...message })
}

function wrote(connection: FakeConnection, text: string): boolean {
  return connection.sent.some((message) => JSON.stringify(message).includes(text))
}

async function openTurn(connection: FakeConnection): Promise<void> {
  const text = 'Write a long reply.'
  const clientMessageId = await send(text)
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
    uuid: 'stopped-turn-leaf',
    parent_tool_use_id: null,
    message: { id: 'msg-1', role: 'assistant', content: [{ type: 'text', text: 'Working on' }] }
  })
  await eventually(async () =>
    expect((await submission(clientMessageId))?.dispatchState).toBe('accepted')
  )
  expect(
    activeStructuredAgentSessionTurnId((await host.journalSnapshot(SESSION)).items)
  ).not.toBeNull()
}

function stop() {
  return host.cancel(CALLER, { envelope: envelope('agentSession.cancel', {}) })
}

function laneDrained(): Promise<void> {
  return host['tasks'].serialize(SESSION, async () => {})
}

/** A commit queues a serialized wake, and the wake queues its delivery step behind that. */
async function commitSettled(): Promise<void> {
  await laneDrained()
  await laneDrained()
}

/** As the real connection: once a close begins it refuses every write, proven or not. */
function closeUnprovenFor(connection: FakeConnection, failures: number): void {
  const close = connection.close
  let left = failures
  connection.close = async () => {
    if (left === 0) {
      return close()
    }
    left -= 1
    connection.closeCount += 1
    connection.closed = true
    return false
  }
  const write = connection.send
  connection.send = (message, beforeDispatch) =>
    connection.closed
      ? Promise.reject(
          claudeUnwrittenUserMessageError(new Error('claude stream-json connection is closed'))
        )
      : write(message, beforeDispatch)
}

const INTERRUPTED_RESULT = {
  type: 'result',
  subtype: 'error_during_execution',
  is_error: true,
  terminal_reason: 'aborted_streaming',
  uuid: 'interrupted-result'
}

/** Stops a turn whose child's close cannot prove the exit `failures` times, and lets the Stop's
 *  second step fail on it. */
async function stopWithUnprovenClose(failures: number): Promise<FakeConnection> {
  const connection = claude.connections[0]!
  await openTurn(connection)
  closeUnprovenFor(connection, failures)
  await expect(stop()).resolves.toMatchObject({ ok: true, value: { cancelled: true } })
  frame(connection, INTERRUPTED_RESULT)
  await laneDrained()
  expect(connection.closeCount).toBe(1)
  expect(owedWindDown()).toBeDefined()
  return connection
}

function owedWindDown() {
  return host['sessions'].get(SESSION)?.owesProviderChildWindDown
}

async function waitRows() {
  await host.flushStreamedEvents(SESSION)
  return (await host.journalSnapshot(SESSION)).items.flatMap((item) =>
    item.body.kind === 'status' && item.body.failure?.kind === 'previousExitUnverifiable'
      ? [item.body]
      : []
  )
}

async function resumedWith(connection: FakeConnection, text: string): Promise<FakeConnection> {
  return eventually(() => {
    const started = claude.connections.at(-1)!
    expect(started).not.toBe(connection)
    expect(wrote(started, text)).toBe(true)
    return started
  })
}

it('retries the close a Stop could not prove before the next message, then sends it to a resumed child', async () => {
  const connection = await stopWithUnprovenClose(1)

  const next = await send('Carry on.')
  const resumed = await resumedWith(connection, 'Carry on.')

  expect(connection.closeCount).toBe(2)
  expect(wrote(connection, 'Carry on.')).toBe(false)
  expect(resumed.closed).toBe(false)
  expect(owedWindDown()).toBeUndefined()
  expect((await submission(next))?.dispatchState).toBe('pending')
  expect(await waitRows()).toEqual([])
})

it('holds the message with its reason while the exit stays unverifiable, and sends it once a later retry proves it', async () => {
  const connection = await stopWithUnprovenClose(3)

  // Never refused: the send is accepted and returns at once.
  const next = await send('Carry on.')
  await eventually(async () => expect(await waitRows()).toHaveLength(1))
  await laneDrained()
  expect(await waitRows()).toEqual([
    {
      kind: 'status',
      tone: 'warning',
      text: 'Claude from before may still be running. Your messages will send once it stops.',
      failure: { kind: 'previousExitUnverifiable' }
    }
  ])
  // Still queued, drawn below the chat; never written to the child the Stop could not end.
  expect(await submission(next)).toMatchObject({ dispatchState: 'pending' })
  expect((await submission(next))?.handedOverAt).toBeUndefined()
  expect(claude.connections).toHaveLength(1)
  expect(wrote(connection, 'Carry on.')).toBe(false)
  expect(owedWindDown()).toBeDefined()
  // The Stop's attempt and the send's one retry: the row's own commit retries nothing.
  expect(connection.closeCount).toBe(2)

  // A second message retries once more, and waits under the same row.
  const second = await send('And this.')
  await eventually(() => expect(connection.closeCount).toBe(3))
  await laneDrained()
  expect(await submission(second)).toMatchObject({ dispatchState: 'pending' })
  expect(await waitRows()).toHaveLength(1)

  // The sweep's next tick retries the stop; the exit is proven and both messages go out.
  await host['lifetime'].idleSweep.tick()
  const resumed = await resumedWith(connection, 'Carry on.')
  await eventually(() => expect(wrote(resumed, 'And this.')).toBe(true))
  expect(connection.closeCount).toBe(4)
  expect(owedWindDown()).toBeUndefined()
  expect(await waitRows()).toHaveLength(1)
})

it('lets a held message be withdrawn with Stop, and the owed stop still ends on the next retry', async () => {
  const connection = await stopWithUnprovenClose(2)
  const next = await send('Carry on.')
  await eventually(async () => expect(await waitRows()).toHaveLength(1))
  await laneDrained()

  await expect(stop()).resolves.toMatchObject({ ok: true, value: { cancelled: true } })
  expect(await submission(next)).toMatchObject({ dispatchState: 'rejected' })
  expect(owedWindDown()).toBeDefined()

  await host['lifetime'].idleSweep.tick()
  expect(connection.closeCount).toBe(3)
  expect(owedWindDown()).toBeUndefined()
  expect(store.getRecord(SESSION)?.lease.claimStatus).toBe('released')
  // Nothing was waiting, so no child starts.
  expect(claude.connections).toHaveLength(1)
  expect(wrote(connection, 'Carry on.')).toBe(false)
})

function setModel(model: string) {
  const fields = { key: 'model', value: model }
  return host.setOption(CALLER, { envelope: envelope('agentSession.setOption', fields), ...fields })
}

it('refuses an option change with the exit unverifiable after retrying the stop, never writing to the old child', async () => {
  const connection = await stopWithUnprovenClose(2)

  await expect(setModel('claude-opus-5')).resolves.toMatchObject({
    ok: false,
    refusal: {
      code: 'agent_session_ownership_unknown',
      details: { reason: 'previousExitUnverifiable', ownerVerdict: 'unverifiable' }
    }
  })
  expect(connection.closeCount).toBe(2)
  expect(connection.calls.some((call) => call.subtype === 'set_model')).toBe(false)
  expect(owedWindDown()).toBeDefined()

  // Trying again retries the stop; proven, the pick is the chat's at rest, for the next start.
  await expect(setModel('claude-opus-5')).resolves.toMatchObject({ ok: true })
  expect(connection.closeCount).toBe(3)
  expect(owedWindDown()).toBeUndefined()
  expect(connection.calls.some((call) => call.subtype === 'set_model')).toBe(false)
  expect(store.getRecord(SESSION)?.options).toMatchObject({ model: 'claude-opus-5' })
  expect(claude.connections).toHaveLength(1)
})

function stopBackgroundTasks() {
  const fields = { scope: 'background-tasks' as const }
  return host.cancel(CALLER, { envelope: envelope('agentSession.cancel', fields), ...fields })
}

/** Holds the user's next message on a Stop whose exit stays unproven through the send's retry. */
async function heldAfterStop(): Promise<FakeConnection> {
  const connection = await stopWithUnprovenClose(2)
  await send('Carry on.')
  await eventually(async () => expect(await waitRows()).toHaveLength(1))
  await laneDrained()
  expect(connection.closeCount).toBe(2)
  return connection
}

it('sends a held message once an option change proves the exit: the stop that lands hands it over', async () => {
  const connection = await heldAfterStop()

  await expect(setModel('claude-opus-5')).resolves.toMatchObject({ ok: true })
  expect(connection.closeCount).toBe(3)
  const resumed = await resumedWith(connection, 'Carry on.')
  expect(resumed.closed).toBe(false)
  expect(owedWindDown()).toBeUndefined()
  expect(store.getRecord(SESSION)?.options).toMatchObject({ model: 'claude-opus-5' })
})

it('sends a held message once a background-task stop proves the exit, though that stop finds no agent', async () => {
  const connection = await heldAfterStop()

  // Proven gone, the old agent has no tasks left to stop, and the message still goes out.
  await expect(stopBackgroundTasks()).resolves.toMatchObject({
    ok: false,
    refusal: { details: { reason: 'noLiveOwner' } }
  })
  expect(connection.closeCount).toBe(3)
  await resumedWith(connection, 'Carry on.')
  expect(owedWindDown()).toBeUndefined()
})

it('sends a message held after a tab close whose exit was unproven, rather than rejecting it as closed', async () => {
  const connection = claude.connections[0]!
  closeUnprovenFor(connection, 2)
  await expect(host.close(SESSION, 'user-close')).rejects.toThrow()
  expect(owedWindDown()).toMatchObject({ cause: 'user-close' })

  // The chat stays open on the host; the user sends again, and the message waits on that close.
  const next = await send('Carry on.')
  await eventually(async () => expect(await waitRows()).toHaveLength(1))
  await laneDrained()
  expect(connection.closeCount).toBe(2)

  // The close was asked for before this message, so the retry that lands ends nothing it waited on.
  await host['lifetime'].idleSweep.tick()
  await laneDrained()
  expect(await submission(next)).not.toMatchObject({ dispatchState: 'rejected' })
  await resumedWith(connection, 'Carry on.')
  expect(owedWindDown()).toBeUndefined()
})

it('never stops a live child for a wind-down another, earlier child still owes', async () => {
  const connection = claude.connections[0]!
  const session = host['sessions'].get(SESSION)!
  session.owesProviderChildWindDown = {
    generation: 'an-earlier-child',
    fence: session.child!.fence,
    cause: 'user-stop',
    requestedAt: session.journal.cursor()
  }

  await send('Carry on.')
  await eventually(() => expect(wrote(connection, 'Carry on.')).toBe(true))
  await laneDrained()
  await host['lifetime'].idleSweep.tick()
  expect(connection.closeCount).toBe(0)
  expect(claude.connections).toHaveLength(1)
})

it('retries once per new message: commits after a second waiting message retry nothing', async () => {
  const connection = await stopWithUnprovenClose(6)
  await send('Carry on.')
  await eventually(async () => expect(await waitRows()).toHaveLength(1))
  await laneDrained()
  await send('And this.')
  await eventually(() => expect(connection.closeCount).toBe(3))
  await laneDrained()

  // Any journal commit wakes the delivery loop while a message is queued.
  const session = host['sessions'].get(SESSION)!
  for (const n of [1, 2, 3]) {
    await session.journal.appendItem(
      { provider: 'orca', clientMessageId: `unrelated-${n}` },
      { kind: 'status', text: `Unrelated ${n}.` },
      { fence: store.getRecord(SESSION)!.lease.runtimeFence, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    await commitSettled()
  }
  expect(connection.closeCount).toBe(3)
  expect(claude.connections).toHaveLength(1)

  // The sweep still retries, one pass a tick, until the exit is proven; then both go out.
  for (const _tick of [1, 2, 3, 4]) {
    await host['lifetime'].idleSweep.tick()
  }
  expect(connection.closeCount).toBe(7)
  const resumed = await resumedWith(connection, 'Carry on.')
  await eventually(() => expect(wrote(resumed, 'And this.')).toBe(true))
})

it('queues a follow-up as a draft by default while a message waits, and Steer retries the stop once for it', async () => {
  const connection = await stopWithUnprovenClose(3)
  await send('Carry on.')
  await eventually(async () => expect(await waitRows()).toHaveLength(1))
  await laneDrained()

  // Queueing follow-ups is the default: the waiting message reads as working, so this is a draft.
  const body = hostTestMessage('And this.')
  const delivery = 'queue-if-active' as const
  const queued = await host.send(CALLER, {
    envelope: envelope('agentSession.send', { body, delivery }),
    body,
    delivery
  })
  expect(queued).toMatchObject({ ok: true, value: { queued: { state: 'waiting' } } })
  await commitSettled()
  expect(connection.closeCount).toBe(2)

  // Steer makes it a waiting message, which retries once and waits under the same note.
  const messageId = queued.ok && 'queued' in queued.value ? queued.value.queued.messageId : ''
  await expect(
    host.queuedMessageSend(CALLER, {
      envelope: envelope('agentSession.queuedMessageSend', { messageId }),
      messageId
    })
  ).resolves.toMatchObject({ ok: true })
  await eventually(() => expect(connection.closeCount).toBe(3))
  await commitSettled()
  expect(connection.closeCount).toBe(3)
  expect(claude.connections).toHaveLength(1)
  expect(await waitRows()).toHaveLength(1)

  await host['lifetime'].idleSweep.tick()
  const resumed = await resumedWith(connection, 'Carry on.')
  await eventually(() => expect(wrote(resumed, 'And this.')).toBe(true))
})

it('rejects as closed a message a second tab close closed, though that close could not reject it itself', async () => {
  const connection = claude.connections[0]!
  closeUnprovenFor(connection, 3)
  await expect(host.close(SESSION, 'user-close')).rejects.toThrow()
  const next = await send('Carry on.')
  await eventually(async () => expect(await waitRows()).toHaveLength(1))
  await laneDrained()
  expect(connection.closeCount).toBe(2)

  // The second close's own rejection of what is queued fails; its stop is a new ask all the same.
  const session = host['sessions'].get(SESSION)!
  vi.spyOn(session.journal, 'rejectQueuedSubmissions').mockRejectedValueOnce(new Error('disk full'))
  await expect(host.close(SESSION, 'user-close')).rejects.toThrow()
  expect(connection.closeCount).toBe(3)
  expect(await submission(next)).toMatchObject({ dispatchState: 'pending' })

  // The retry that proves the exit closes what that second close closed.
  await host['lifetime'].idleSweep.tick()
  await commitSettled()
  expect(connection.closeCount).toBe(4)
  expect(await submission(next)).toMatchObject({ dispatchState: 'rejected' })
  expect(claude.connections).toHaveLength(1)
})

it('notes why a message waits when another operation failed its retry before the message was delivered', async () => {
  const connection = await stopWithUnprovenClose(2)

  // The send is accepted, then the option change's failed retry runs before the send's delivery.
  const sent = send('Carry on.')
  const option = setModel('claude-opus-5')
  await expect(option).resolves.toMatchObject({
    ok: false,
    refusal: { details: { reason: 'previousExitUnverifiable' } }
  })
  await sent
  await commitSettled()
  expect(connection.closeCount).toBe(2)
  expect(await waitRows()).toHaveLength(1)
  expect(claude.connections).toHaveLength(1)
})

it('keeps an option change at rest when the Stop proved the exit and only its bookkeeping keeps failing', async () => {
  const connection = claude.connections[0]!
  await openTurn(connection)
  // The close proves the exit; draining what the old agent wrote fails for the Stop. The Stop reads
  // the journal without a drain, so its close is the first and only drain to fail here.
  const barrierLost = { ok: false as const, error: new Error('drain barrier lost') }
  const drained = vi
    .spyOn(host['runtimeState'].eventSinkFor(SESSION), 'drained')
    .mockResolvedValueOnce(barrierLost)
  await expect(stop()).resolves.toMatchObject({ ok: true, value: { cancelled: true } })
  frame(connection, INTERRUPTED_RESULT)
  await laneDrained()
  expect(connection.closeCount).toBe(1)
  expect(host['sessions'].get(SESSION)?.child).toBeNull()
  expect(owedWindDown()).toBeDefined()

  // The option change's retry of that bookkeeping fails again: reported, and the pick still lands.
  drained.mockResolvedValueOnce(barrierLost)
  await expect(setModel('claude-opus-5')).resolves.toMatchObject({ ok: true })
  expect(owedWindDown()).toBeDefined()
  expect(log.scopes().filter((scope) => scope === 'owed-stop-retry')).toHaveLength(1)
  expect(store.getRecord(SESSION)?.options).toMatchObject({ model: 'claude-opus-5' })
  expect(connection.closeCount).toBe(1)
  expect(claude.connections).toHaveLength(1)
})
