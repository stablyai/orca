import type { AgentJournalRenderItem } from '../../../shared/agent-session-journal-types'
import type { AgentSessionSubscribeEvent } from '../../../shared/agent-session-wire'
// Stop notes follow interrupted ends written by the shipping Claude translator.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { isStructuredAgentSessionStopNote } from './structured-agent-session-command-turn'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
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
import { claudeAndCodexDeclared } from './structured-agent-session-adapter-router-test-support'
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

let events: AgentSessionSubscribeEvent[]
let unconfirmedNote: AgentJournalRenderItem | undefined
let root: string
let host: StructuredAgentSessionHost
let adapter: ClaudeStructuredSessionAdapter
let store: AgentSessionRecordStore
let claude: ReturnType<typeof fakeClaude>
let log: ReturnType<typeof recordingStructuredAgentSessionLogger>
let persistHandle: ReturnType<typeof vi.fn<() => Promise<void>>>
let childWork: string[]

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-claude-stop-exit-ends-record-'))
  resetHostTestOperationIds()
  events = []
  unconfirmedNote = undefined
  log = recordingStructuredAgentSessionLogger()
  persistHandle = vi.fn(async () => undefined)
  childWork = []
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
    persistHandle: () => persistHandle(),
    logger: log.logger,
    onChildWorkEvidence: (sessionId, evidence) => {
      childWork.push(...evidence.map((edge) => edge.type))
      host.publishChildWorkEvidence(sessionId, evidence)
    },
    openConnection: claude.openConnection,
    readProcessStartTime: async () => 1_700_000_000_000,
    now: () => NOW
  })
  store = await openTestAgentSessionRecordStore(root)
  host = new StructuredAgentSessionHost({
    agents: claudeAndCodexDeclared(),
    store,
    adapter: Object.assign(adapter, { supportsCreate: () => true }),
    journalDatabase: openTestJournalHostDatabase(root),
    claimKeyId: 'key-1',
    mintSpawnToken: () => 'spawn-a',
    logger: log.logger,
    // Ticked by hand only, and with no idle window: a tick reaps whatever is at rest.
    idleSweep: { intervalMs: 3_600_000, idleMs: 0 },
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
  await host.subscribe({
    id: 'stop-note-live',
    sessionId: SESSION,
    emit: (event) => events.push(event)
  })
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
  refuseWritesOnceClosed(connection)
}

function refuseWritesOnceClosed(connection: FakeConnection): void {
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

async function notesAndTurn() {
  await host.flushStreamedEvents(SESSION)
  const items = (await host.journalSnapshot(SESSION)).items
  return {
    notes: items.filter((item) => isStructuredAgentSessionStopNote(item.itemId)),
    turn: items.find((item) => item.body.kind === 'turn')
  }
}

async function unconfirmedStop(): Promise<FakeConnection> {
  const connection = claude.connections[0]!
  await openTurn(connection)
  closeUnprovenFor(connection, 1)
  await expect(stop()).resolves.toMatchObject({ ok: true })
  await eventually(async () => {
    const { notes, turn } = await notesAndTurn()
    expect(notes).toHaveLength(1)
    expect(notes[0]?.body).toMatchObject({ failure: { kind: 'cancelUnconfirmed' } })
    expect(turn?.body).toMatchObject({ state: 'running' })
    unconfirmedNote = notes[0]
  })
  return connection
}

async function confirmedNote(): Promise<void> {
  await eventually(async () => {
    const { notes, turn } = await notesAndTurn()
    expect(turn?.body).toMatchObject({ state: 'interrupted' })
    expect(notes).toHaveLength(1)
    expect(notes[0]?.body).toEqual({ kind: 'status', text: 'Cancellation requested.' })
    expect(notes[0]?.turnScope).toEqual({ kind: 'turn', turnItemId: turn?.itemId })
    expect(notes[0]).toMatchObject({
      itemId: unconfirmedNote?.itemId,
      revision: unconfirmedNote?.revision,
      sequence: unconfirmedNote?.sequence
    })
    const journal = host['sessions'].get(SESSION)!.journal
    expect(journal.itemBody(notes[0]!.itemId)).toMatchObject({
      failure: { kind: 'cancelUnconfirmed' }
    })
    expect(
      events.some(
        (event) =>
          event.type === 'batch' &&
          event.batch.items.some(
            (item) =>
              item.itemId === notes[0]?.itemId &&
              item.body.kind === 'status' &&
              item.body.text === 'Cancellation requested.' &&
              !item.body.failure
          ) &&
          event.batch.items.some(
            (item) =>
              item.itemId === turn?.itemId &&
              item.body.kind === 'turn' &&
              item.body.state === 'interrupted'
          )
      )
    ).toBe(true)
  })
}

it("says the Stop took once the agent's process exits on its own after the kill timed out", async () => {
  const connection = await unconfirmedStop()
  connection.handlers.onExit?.(new Error('claude exited'), { expected: true })
  await laneDrained()
  await confirmedNote()
})

it('projects the note when a second Stop joins the close and proves the exit', async () => {
  await unconfirmedStop()
  await expect(stop()).resolves.toMatchObject({ ok: true })
  await confirmedNote()
})

it('projects the note when a send joins the close and proves the exit', async () => {
  const connection = await unconfirmedStop()
  await send('Carry on.')
  await eventually(() => {
    const resumed = claude.connections.at(-1)!
    expect(resumed).not.toBe(connection)
    expect(wrote(resumed, 'Carry on.')).toBe(true)
  })
  await confirmedNote()
})

it("projects the note when Claude's own interrupted result ends the turn", async () => {
  const connection = await unconfirmedStop()
  frame(connection, INTERRUPTED_RESULT)
  await laneDrained()
  await confirmedNote()
})

it('keeps the note unconfirmed when the turn completes', async () => {
  const connection = await unconfirmedStop()
  frame(connection, {
    type: 'result',
    subtype: 'success',
    is_error: false,
    uuid: 'completed-result'
  })
  await eventually(async () => {
    const { notes, turn } = await notesAndTurn()
    expect(turn?.body).toMatchObject({ state: 'completed' })
    expect(notes).toHaveLength(1)
    expect(notes[0]?.body).toMatchObject({ failure: { kind: 'cancelUnconfirmed' } })
  })
})
