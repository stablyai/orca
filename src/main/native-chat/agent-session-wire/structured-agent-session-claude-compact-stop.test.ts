// Stop and `/compact` on the shipping Claude adapter, driven by the frames a stream-json child
// writes: which result ends the command, and what the next message is handed to.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import { ClaudeControlRequestError } from '../../claude/claude-agent-sdk-control-requests'
import { ClaudeStructuredSessionAdapter } from '../../claude/claude-structured-session-adapter'
import {
  fakeClaude,
  PROVIDER_SESSION_ID,
  type FakeConnection
} from '../../claude/claude-structured-session-test-support'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import { structuredClaudeLifecycleEvent } from '../../runtime/structured-claude-runtime-adapter'
import { structuredAgentSessionCommandTurn } from './structured-agent-session-command-turn'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  hostTestAttachParams,
  hostTestMessage,
  hostTestOperationId,
  resetHostTestOperationIds
} from './structured-agent-session-host-test-data'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import { createStructuredAgentSessionLogger } from './structured-agent-session-logger'

const CALLER = { callerKey: 'client-1' }

let root: string
let store: AgentSessionRecordStore
let host: StructuredAgentSessionHost
let adapter: ClaudeStructuredSessionAdapter
let claude: ReturnType<typeof fakeClaude>
/** The adapter's clock, which a real child's exit reads at a different instant than the host's. */
let adapterNow = NOW

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-claude-compact-stop-'))
  resetHostTestOperationIds()
  adapterNow = NOW + 7
  // No echo of its own: each test writes the frames Claude would.
  claude = fakeClaude({ replayUuid: null })
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
        void host.handleAdapterEvent(mapped)
      }
    },
    // The runtime's own wiring: the provider's answer is what settles a send it took.
    onDispatchSettledLate: (settlement) => void host.settleLateDispatch(settlement),
    openConnection: claude.openConnection,
    readProcessStartTime: async () => 1_700_000_000_000,
    now: () => adapterNow
  })
  store = await openTestAgentSessionRecordStore(root)
  host = new StructuredAgentSessionHost({
    logger: createStructuredAgentSessionLogger(),
    store,
    // The production router is what declares create support; the bare adapter only knows locations.
    adapter: Object.assign(adapter, { supportsCreate: () => true }),
    journalDatabase: openTestJournalHostDatabase(root),
    claimKeyId: 'key-1',
    mintSpawnToken: () => 'spawn-a',
    now: () => NOW
  })
  const attached = await host.attach(
    CALLER,
    hostTestAttachParams(null, {
      provider: 'claude',
      agent: 'claude',
      accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: join(root, 'claude-home') },
      providerHandle: { kind: 'claude', sessionId: PROVIDER_SESSION_ID, leafUuid: null }
    })
  )
  expect(attached).toMatchObject({ ok: true })
  await adapter.awaitStarted(SESSION)
})

afterEach(async () => {
  await adapter.closeAll()
  await host.flushAllStreamedEvents()
  await rm(root, { recursive: true, force: true })
})

function envelope(method: string, fields: Record<string, unknown>) {
  return {
    sessionId: SESSION,
    clientOperationId: hostTestOperationId(),
    expectedRuntimeFence: store.getRecord(SESSION)?.lease.runtimeFence ?? 1,
    payloadFingerprint: computeAgentSessionPayloadFingerprint({
      method,
      sessionId: SESSION,
      fields
    })
  }
}

async function compact(): Promise<string> {
  const params = {
    command: 'compact' as const,
    envelope: envelope('agentSession.conversationCommand', { command: 'compact' })
  }
  await expect(host.conversationCommand(CALLER, params)).resolves.toMatchObject({ ok: true })
  return params.envelope.clientOperationId
}

function stop(cmid: string) {
  const { turnId } = structuredAgentSessionCommandTurn(cmid)
  return host.cancel(CALLER, { envelope: envelope('agentSession.cancel', { turnId }), turnId })
}

/** The uuid of the frame that carried `text` to Claude, and the child it went to. */
async function sent(text: string): Promise<{ connection: FakeConnection; uuid: string }> {
  return vi.waitFor(() => {
    for (const connection of claude.connections) {
      const frame = connection.sent.find((message) => JSON.stringify(message).includes(text))
      if (frame) {
        return { connection, uuid: String(frame.uuid) }
      }
    }
    throw new Error(`nothing sent ${text}`)
  })
}

function frame(connection: FakeConnection, message: Record<string, unknown>): void {
  connection.handlers.onMessage?.({ session_id: PROVIDER_SESSION_ID, ...message })
}

function result(uuid: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    uuid: `result-${uuid}`,
    user_message_uuid: uuid,
    ...overrides
  }
}

const INTERRUPTED = {
  subtype: 'error_during_execution',
  is_error: true,
  terminal_reason: 'aborted_streaming'
}

async function commandState(cmid: string) {
  await host.flushStreamedEvents(SESSION)
  const { itemId } = structuredAgentSessionCommandTurn(cmid)
  const snapshot = await host.journalSnapshot(SESSION)
  return readAgentJournalTurn(snapshot.items.find((item) => item.itemId === itemId)?.body)
}

it('ends a hung /compact Claude will not interrupt by stopping it, and answers the next send in its own turn', async () => {
  claude.routes.interrupt = () => {
    throw new ClaudeControlRequestError('interrupt', 'Claude did not answer the interrupt.')
  }
  const cmid = await compact()
  const { connection: compacting } = await sent('/compact')

  await expect(stop(cmid)).resolves.toMatchObject({ ok: true, value: { cancelled: true } })
  await vi.waitFor(async () => expect((await commandState(cmid))?.state).toBe('interrupted'))

  const body = hostTestMessage('what next?')
  await host.send(CALLER, { envelope: envelope('agentSession.send', { body }), body })
  const { connection, uuid } = await sent('what next?')
  expect(compacting.closed).toBe(true)
  expect(connection).not.toBe(compacting)
  frame(connection, {
    type: 'user',
    uuid,
    parent_tool_use_id: null,
    message: { role: 'user', content: [{ type: 'text', text: 'what next?' }] }
  })
  frame(connection, {
    type: 'assistant',
    uuid: 'answer',
    parent_tool_use_id: null,
    message: { id: 'msg-1', role: 'assistant', content: [{ type: 'text', text: 'Here is.' }] }
  })
  frame(connection, result(uuid))

  await vi.waitFor(async () => {
    await host.flushStreamedEvents(SESSION)
    const snapshot = await host.journalSnapshot(SESSION)
    const answer = snapshot.items.find(
      (item) => item.body.kind === 'message' && item.body.role === 'assistant'
    )
    expect(answer?.turnScope).toMatchObject({ kind: 'turn' })
    expect(answer?.turnScope).not.toEqual({
      kind: 'turn',
      turnItemId: structuredAgentSessionCommandTurn(cmid).itemId
    })
  })
})

it('ends a stopped /compact on its own interrupted result, then ends its child; a late copy never reaches the next one', async () => {
  claude.routes.interrupt = () => ({})
  const first = await compact()
  const { connection, uuid: firstUuid } = await sent('/compact')

  await expect(stop(first)).resolves.toMatchObject({ ok: true, value: { cancelled: true } })
  // The interrupt was taken: the child waits for Claude to end the command itself.
  expect(connection.closed).toBe(false)
  frame(connection, result(firstUuid, INTERRUPTED))
  await vi.waitFor(() => expect(connection.closed).toBe(true))
  expect(await commandState(first)).toMatchObject({
    state: 'interrupted',
    outcome: 'cancellation'
  })

  const second = await compact()
  const next = await vi.waitFor(() => {
    const started = claude.connections.at(-1)
    expect(started).not.toBe(connection)
    expect(started?.sent.some((message) => JSON.stringify(message).includes('/compact'))).toBe(true)
    return started!
  })
  const secondUuid = String(next.sent.at(-1)?.uuid)
  frame(connection, result(firstUuid, INTERRUPTED))
  expect((await commandState(second))?.state).toBe('running')

  frame(next, { type: 'system', subtype: 'compact_boundary', uuid: 'boundary' })
  frame(next, result(secondUuid))
  await vi.waitFor(async () =>
    expect(await commandState(second)).toMatchObject({ state: 'completed', outcome: 'success' })
  )
})

it('settles a /compact whose Claude child exits mid-command through that child, and delivers what waited', async () => {
  const cmid = await compact()
  const { connection: compacting } = await sent('/compact')
  const body = hostTestMessage('after the exit')
  await host.send(CALLER, { envelope: envelope('agentSession.send', { body }), body })

  // Claude sends no end frame at all: its child is gone.
  compacting.handlers.onExit?.(new Error('claude stream-json exited (code 1): crashed'))

  await vi.waitFor(async () => expect((await commandState(cmid))?.state).toBe('interrupted'))
  const { connection } = await sent('after the exit')
  expect(connection).not.toBe(compacting)
})

it('tells why a /compact ended when its Claude child exits after taking it', async () => {
  const cmid = await compact()
  const { connection, uuid } = await sent('/compact')
  // Claude echoes the command, so the send is answered; then the child dies with no end frame.
  frame(connection, {
    type: 'user',
    uuid,
    parent_tool_use_id: null,
    message: { role: 'user', content: [{ type: 'text', text: '/compact' }] }
  })
  await host.flushStreamedEvents(SESSION)
  adapterNow = NOW + 7
  connection.handlers.onExit?.(new Error('claude stream-json exited (code 1)'))

  await vi.waitFor(async () => expect((await commandState(cmid))?.state).toBe('interrupted'))
  await vi.waitFor(async () => {
    await host.flushStreamedEvents(SESSION)
    const snapshot = await host.journalSnapshot(SESSION)
    // The exit's words are the host's sentence, never Claude's log text.
    const exitRow = snapshot.items.find(
      (item) => item.body.kind === 'status' && item.body.failure?.kind === 'providerExited'
    )
    expect(exitRow?.body).toMatchObject({
      text: 'Claude stopped while this response was in progress. You can continue in this conversation.',
      tone: 'error'
    })
    expect(exitRow?.turnScope).toEqual({
      kind: 'turn',
      turnItemId: structuredAgentSessionCommandTurn(cmid).itemId
    })
  })
})
