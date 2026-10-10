// A follow-up sent before Claude echoes the first message waits for the turn that echo opens, then
// goes in scoped to it: the CLI folds it into that turn, and the client draws it there, never as a
// message of its own ahead of the reply. On the shipping adapter and host, fed the CLI's captured
// early-steer frame order (CLI 2.1.280).

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import { projectStructuredAgentSessionMessages } from '../../../shared/structured-agent-session-message-projection'
import { projectNativeChatTranscriptMessages } from '../../../shared/native-chat-transcript-projection'
import { nativeChatRowsInDrawOrder } from '../../../shared/native-chat-turn-grouping'
import { nativeChatTurnMembership } from '../../../shared/native-chat-turn-membership'
import { ClaudeStructuredSessionAdapter } from '../../claude/claude-structured-session-adapter'
import {
  claudeStartupSettled,
  fakeClaude,
  PROVIDER_SESSION_ID,
  type FakeConnection
} from '../../claude/claude-structured-session-test-support'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import { structuredClaudeLifecycleEvent } from '../../runtime/structured-claude-runtime-adapter'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  hostTestAttachParams,
  hostTestMessage,
  hostTestOperationId,
  resetHostTestOperationIds
} from './structured-agent-session-host-test-data'
import { recordingStructuredAgentSessionLogger } from './structured-agent-session-logger-test-support'
import { claudeAndCodexDeclared } from './structured-agent-session-adapter-router-test-support'
import { isStructuredAgentSessionMainAgentWorking } from '../../../shared/structured-agent-session-main-agent-working'
import { DISPATCH_DOUBT_PROVIDER_IDLE } from '../agent-session-journal/journal-dispatch-doubt-reasons'
import { claudeUnwrittenUserMessageError } from '../../claude/claude-agent-sdk-user-message-queue'

const CALLER = { callerKey: 'client-1' }
const CAPABILITIES = ['interrupt_receipt_v1', 'interrupt_cancel_queued_v1', 'msg_lifecycle_v1']

let root: string
let host: StructuredAgentSessionHost
let adapter: ClaudeStructuredSessionAdapter
let store: AgentSessionRecordStore
let claude: ReturnType<typeof fakeClaude>

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-claude-opening-send-'))
  resetHostTestOperationIds()
  const log = recordingStructuredAgentSessionLogger()
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
      // A child started after a Stop's close resumes the conversation that close ended.
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
    agents: claudeAndCodexDeclared(),
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
  await claudeStartupSettled(adapter, SESSION)
  await Promise.all(lifecycle)
})

afterEach(async () => {
  await adapter.closeAll()
  await host.flushAllStreamedEvents()
  await rm(root, { recursive: true, force: true })
})

const eventually = <T>(assertion: () => T | Promise<T>) =>
  vi.waitFor(assertion, { timeout: 10_000 })

async function send(text: string): Promise<string> {
  const body = hostTestMessage(text)
  const sent = await host.send(CALLER, {
    envelope: {
      sessionId: SESSION,
      clientOperationId: hostTestOperationId(),
      expectedRuntimeFence: store.getRecord(SESSION)!.lease.runtimeFence,
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

function frame(connection: FakeConnection, message: Record<string, unknown>): void {
  connection.handlers.onMessage?.({ session_id: PROVIDER_SESSION_ID, ...message })
}

function written(connection: FakeConnection, text: string): Record<string, unknown> | undefined {
  return connection.sent.find((message) => JSON.stringify(message).includes(text))
}

async function snapshot() {
  await host.flushStreamedEvents(SESSION)
  return host.journalSnapshot(SESSION)
}

/** Each row's text and the turn it is drawn in, in the order the client draws the conversation. */
async function drawn(): Promise<{ text: string; turn: string | undefined }[]> {
  const { items, submissions } = await snapshot()
  const rows = projectNativeChatTranscriptMessages(
    projectStructuredAgentSessionMessages(items, [], submissions, { rejectedInPlace: true })
  )
  const { drawOrder, turnKeys } = nativeChatTurnMembership(rows, { items, submissions })
  const keyed = rows.map((row, index) => ({
    text: row.blocks.map((block) => ('text' in block ? block.text : block.type)).join(''),
    turn: turnKeys[index]
  }))
  return [...nativeChatRowsInDrawOrder(keyed, drawOrder)]
}

it('holds a follow-up until the echo opens the turn, then folds it in, drawn inside that turn', async () => {
  const connection = claude.connections[0]!
  const first = await send('FIRST prompt')
  await eventually(() => expect(written(connection, 'FIRST prompt')).toBeDefined())
  const steer = await send('STEER prompt')
  await eventually(() =>
    expect(host.collaboratorsForTests().conversationDelivery.loop.isRunning(SESSION)).toBe(false)
  )

  // Not written to the CLI, and still queued, until the turn it would join has opened.
  expect(written(connection, 'STEER prompt')).toBeUndefined()
  const queued = (await snapshot()).submissions.find((entry) => entry.clientMessageId === steer)
  expect(queued?.handedOverAt).toBeUndefined()

  const firstFrame = written(connection, 'FIRST prompt')!
  frame(connection, {
    type: 'system',
    subtype: 'init',
    uuid: 'init-1',
    model: 'claude-sonnet-5',
    capabilities: CAPABILITIES
  })
  frame(connection, { ...firstFrame, isReplay: true, parent_tool_use_id: null })
  await eventually(() => expect(written(connection, 'STEER prompt')).toBeDefined())
  const steerFrame = written(connection, 'STEER prompt')!
  frame(connection, {
    type: 'assistant',
    uuid: 'reply-tool-1',
    parent_tool_use_id: null,
    message: {
      id: 'msg-reply-tool-1',
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'toolu_sleep_1', name: 'Bash', input: { command: 'sleep 5' } }
      ]
    },
    user_message_uuid: firstFrame.uuid,
    user_message_uuids: [firstFrame.uuid]
  })
  frame(connection, {
    type: 'user',
    uuid: 'tool-result-1',
    parent_tool_use_id: null,
    message: {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_sleep_1', content: 'done', is_error: false }
      ]
    }
  })
  frame(connection, { ...steerFrame, isReplay: true, parent_tool_use_id: null })
  frame(connection, {
    type: 'assistant',
    uuid: 'reply-text-1',
    parent_tool_use_id: null,
    message: {
      id: 'msg-reply-text-1',
      role: 'assistant',
      content: [{ type: 'text', text: 'FIRST DONE banana' }]
    }
  })
  frame(connection, {
    type: 'result',
    subtype: 'success',
    uuid: 'result-1',
    is_error: false,
    terminal_reason: 'completed',
    duration_ms: 7155,
    num_turns: 2,
    result: 'FIRST DONE',
    user_message_uuid: firstFrame.uuid,
    user_message_uuids: [firstFrame.uuid, steerFrame.uuid]
  })
  frame(connection, { type: 'system', subtype: 'session_state_changed', state: 'idle' })
  await eventually(async () =>
    expect(
      (await snapshot()).submissions.find((entry) => entry.clientMessageId === steer)?.dispatchState
    ).toBe('accepted')
  )

  const { items } = await snapshot()
  expect(items.filter((item) => item.body.kind === 'turn')).toHaveLength(1)
  expect(
    items.find((item) => item.itemId === agentJournalSubmissionKey(steer))?.turnScope
  ).toMatchObject({ kind: 'turn' })
  const rows = await drawn()
  const turnOf = (text: string) => rows.find((row) => row.text === text)?.turn
  expect(rows.map((row) => row.text)).toContain('FIRST DONE banana')
  expect(turnOf('STEER prompt')).toBe(turnOf('FIRST prompt'))
  expect(rows.findIndex((row) => row.text === 'STEER prompt')).toBeLessThan(
    rows.findIndex((row) => row.text === 'FIRST DONE banana')
  )
  expect(first).not.toBe(steer)
})

// Claude's own facts end the wait: a send the CLI started and then went idle on without echoing is
// doubt (`releaseClaudeDispatchesUnansweredAtIdle`), with no clock in the host or the adapter.
it('releases the follow-up when the CLI goes idle on a started send it never echoed', async () => {
  const connection = claude.connections[0]!
  const first = await send('FIRST prompt')
  await eventually(() => expect(written(connection, 'FIRST prompt')).toBeDefined())
  const steer = await send('STEER prompt')
  await eventually(() =>
    expect(host.collaboratorsForTests().conversationDelivery.loop.isRunning(SESSION)).toBe(false)
  )
  expect(written(connection, 'STEER prompt')).toBeUndefined()

  frame(connection, {
    type: 'system',
    subtype: 'init',
    uuid: 'init-1',
    model: 'claude-sonnet-5',
    capabilities: CAPABILITIES
  })
  const firstFrame = written(connection, 'FIRST prompt')!
  frame(connection, {
    type: 'command_lifecycle',
    command_uuid: firstFrame.uuid,
    state: 'started',
    uuid: 'lifecycle-first'
  })
  frame(connection, { type: 'system', subtype: 'session_state_changed', state: 'idle' })

  await eventually(() => expect(written(connection, 'STEER prompt')).toBeDefined())
  const submissions = (await snapshot()).submissions
  expect(submissions.find((entry) => entry.clientMessageId === first)).toMatchObject({
    dispatchState: 'unknown',
    reason: DISPATCH_DOUBT_PROVIDER_IDLE
  })
  expect(submissions.find((entry) => entry.clientMessageId === steer)?.handedOverAt).toBeDefined()
})

/** A person's Stop naming no turn. */
function stop() {
  return host.cancel(CALLER, {
    envelope: {
      sessionId: SESSION,
      clientOperationId: hostTestOperationId(),
      expectedRuntimeFence: store.getRecord(SESSION)!.lease.runtimeFence,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.cancel',
        sessionId: SESSION,
        fields: {}
      })
    }
  })
}

// Claude's interrupt names no turn, but its Stop ends the CLI, and that end settles the send.
it('settles a send a Stop took before its echo, and the next message goes out', async () => {
  const connection = claude.connections[0]!
  const first = await send('FIRST prompt')
  await eventually(() => expect(written(connection, 'FIRST prompt')).toBeDefined())

  expect(await stop()).toMatchObject({ ok: true, value: { cancelled: true } })
  await eventually(() => expect(connection.closeCount).toBe(1))
  await eventually(async () =>
    expect(
      (await snapshot()).submissions.find((entry) => entry.clientMessageId === first)?.dispatchState
    ).not.toBe('pending')
  )
  const after = await snapshot()
  expect(
    isStructuredAgentSessionMainAgentWorking(
      null,
      after.submissions,
      store.getRecord(SESSION)!.lease.runtimeFence
    )
  ).toBe(false)

  await send('NEXT prompt')
  await eventually(() => {
    const resumed = claude.connections.at(-1)!
    expect(resumed).not.toBe(connection)
    expect(written(resumed, 'NEXT prompt')).toBeDefined()
  })
})

/** As the real connection: once a close begins it refuses every write; the first `failures`
 *  closes come back unproven. */
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

/** A turn the CLI opened and is writing, whose Stop's close comes back unproven once. */
async function stoppedWithUnprovenClose(): Promise<FakeConnection> {
  const connection = claude.connections[0]!
  const working = await send('Write a long reply.')
  await eventually(() => expect(written(connection, 'Write a long reply.')).toBeDefined())
  frame(connection, {
    type: 'system',
    subtype: 'init',
    uuid: 'init-1',
    model: 'claude-sonnet-5',
    capabilities: CAPABILITIES
  })
  frame(connection, { ...written(connection, 'Write a long reply.')! })
  frame(connection, {
    type: 'assistant',
    uuid: 'stopped-turn-leaf',
    parent_tool_use_id: null,
    message: { id: 'msg-1', role: 'assistant', content: [{ type: 'text', text: 'Working on' }] }
  })
  await eventually(async () =>
    expect(
      (await snapshot()).submissions.find((entry) => entry.clientMessageId === working)
        ?.dispatchState
    ).toBe('accepted')
  )
  closeUnprovenFor(connection, 1)
  expect(await stop()).toMatchObject({ ok: true })
  frame(connection, {
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    terminal_reason: 'aborted_streaming',
    uuid: 'interrupted-result'
  })
  await eventually(() => expect(connection.closeCount).toBe(1))
  return connection
}

// The first message joins the close the Stop could not prove and goes to the resumed child; one
// sent before that child echoes it waits for the echo, as any follow-up waits for its turn.
it('sends a message that joins an unproven Stop close to the resumed child, and holds the next until its echo', async () => {
  const connection = await stoppedWithUnprovenClose()

  await send('Carry on.')
  const resumed = await eventually(() => {
    const started = claude.connections.at(-1)!
    expect(started).not.toBe(connection)
    expect(written(started, 'Carry on.')).toBeDefined()
    return started
  })
  const later = await send('And this.')
  await eventually(() =>
    expect(host.collaboratorsForTests().conversationDelivery.loop.isRunning(SESSION)).toBe(false)
  )
  expect(written(connection, 'Carry on.')).toBeUndefined()
  expect(written(resumed, 'And this.')).toBeUndefined()
  expect(
    (await snapshot()).submissions.find((entry) => entry.clientMessageId === later)?.handedOverAt
  ).toBeUndefined()

  frame(resumed, {
    type: 'system',
    subtype: 'init',
    uuid: 'init-resumed',
    model: 'claude-sonnet-5',
    capabilities: CAPABILITIES
  })
  frame(resumed, { ...written(resumed, 'Carry on.')!, isReplay: true, parent_tool_use_id: null })
  await eventually(() => expect(written(resumed, 'And this.')).toBeDefined())
})
