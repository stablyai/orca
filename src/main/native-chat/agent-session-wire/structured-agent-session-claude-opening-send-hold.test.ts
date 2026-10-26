// Captured Claude 2.1.280 early-steer ordering: follow-ups wait for the opening echo before joining its turn.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import { agentSessionSendSubmission } from '../../../shared/agent-session-wire'
import { projectStructuredAgentSessionMessages } from '../../../shared/structured-agent-session-message-projection'
import { projectNativeChatTranscriptMessages } from '../../../shared/native-chat-transcript-projection'
import { nativeChatRowsInDrawOrder } from '../../../shared/native-chat-turn-grouping'
import { nativeChatTurnMembership } from '../../../shared/native-chat-turn-membership'
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
import { retireOutgrownStructuredAgentSessionChild } from './structured-agent-session-outgrown-child'
import type * as OutgrownChild from './structured-agent-session-outgrown-child'
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
import { claudeStructuredPermissionOptions } from '../../claude/claude-structured-launch-resolution'
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import { runningStructuredAgentSessionTurnItemBySequence } from '../../../shared/structured-agent-session-live-turn'
import type * as LiveTurn from '../../../shared/structured-agent-session-live-turn'

vi.mock('../../../shared/structured-agent-session-live-turn', async (importOriginal) => {
  const actual = await importOriginal<typeof LiveTurn>()
  return {
    ...actual,
    runningStructuredAgentSessionTurnItemBySequence: vi.fn(
      actual.runningStructuredAgentSessionTurnItemBySequence
    )
  }
})

vi.mock('./structured-agent-session-outgrown-child', async (importOriginal) => {
  const actual = await importOriginal<typeof OutgrownChild>()
  return {
    ...actual,
    retireOutgrownStructuredAgentSessionChild: vi.fn(
      actual.retireOutgrownStructuredAgentSessionChild
    )
  }
})

const CALLER = { callerKey: 'client-1' }
const CAPABILITIES = ['interrupt_receipt_v1', 'interrupt_cancel_queued_v1', 'msg_lifecycle_v1']

let root: string
let host: StructuredAgentSessionHost
let adapter: ClaudeStructuredSessionAdapter
let store: AgentSessionRecordStore
let claude: ReturnType<typeof fakeClaude>
let claudeFrames: { replayUuid: null; initProof?: 'none' }

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-claude-opening-send-'))
  resetHostTestOperationIds()
  const log = recordingStructuredAgentSessionLogger()
  claudeFrames = { replayUuid: null }
  claude = fakeClaude(
    Object.assign(claudeFrames, {
      routes: { interrupt: () => ({ still_queued: [], cancelled: [] }) }
    })
  )
  const lifecycle: Promise<void>[] = []
  adapter = new ClaudeStructuredSessionAdapter({
    resolveLaunch: async ({ permissionMode }) => ({
      pathToClaudeCodeExecutable: 'claude',
      options: claudeStructuredPermissionOptions(permissionMode ?? 'ask'),
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
    options: { model: 'haiku', permissionMode: 'auto' },
    accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: join(root, 'claude-home') },
    providerHandle: { kind: 'claude', sessionId: PROVIDER_SESSION_ID, leafUuid: null }
  })
  expect(await host.attach(CALLER, params)).toMatchObject({ ok: true })
  await vi.waitFor(() => expect(host.readStatusSummary(SESSION)?.hostExecutionPhase).toBe('ready'))
  await Promise.all(lifecycle)
})

afterEach(async () => {
  await adapter.closeAll()
  await host.flushAllStreamedEvents()
  await rm(root, { recursive: true, force: true })
})

const eventually = <T>(assertion: () => T | Promise<T>) =>
  vi.waitFor(assertion, { timeout: 10_000 })

async function send(text: string, options?: Record<string, string>): Promise<string> {
  const body = hostTestMessage(text)
  const sent = await host.send(CALLER, {
    envelope: {
      sessionId: SESSION,
      clientOperationId: hostTestOperationId(),
      expectedRuntimeFence: store.getRecord(SESSION)!.lease.runtimeFence,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.send',
        sessionId: SESSION,
        fields: { body, options }
      })
    },
    body,
    options
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

async function drawn(): Promise<{ text: string; turn: string | undefined }[]> {
  const { items, submissions } = await snapshot()
  const rows = projectNativeChatTranscriptMessages(
    projectStructuredAgentSessionMessages(items, [], submissions)
  )
  const { drawOrder, turnKeys } = nativeChatTurnMembership(rows, { items, submissions })
  const keyed = rows.map((row, index) => ({
    text: row.blocks.map((block) => ('text' in block ? block.text : block.type)).join(''),
    turn: turnKeys[index]
  }))
  return [...nativeChatRowsInDrawOrder(keyed, drawOrder)]
}

it('reads a send as accepted across its echo, never in doubt, so a worker start keeps its worker', async () => {
  const connection = claude.connections[0]!
  const first = await send('FIRST prompt')
  await eventually(() => expect(written(connection, 'FIRST prompt')).toBeDefined())
  // Worker-start waits here; premature uncertainty previously closed the new worker (STA-11160).
  const answer = host.waitForSendSettlement(SESSION, first, { budgetMs: 5_000 })
  frame(connection, {
    ...written(connection, 'FIRST prompt')!,
    isReplay: true,
    parent_tool_use_id: null
  })
  expect(agentSessionSendSubmission((await answer)?.value)?.dispatchState).toBe('accepted')
})

it('protects an admitted unechoed input from a model transition, then reopens for a fresh choice', async () => {
  claudeFrames.initProof = 'none'
  const connection = claude.connections[0]!
  expect(connection.launch.options).toMatchObject({ model: 'haiku', permissionMode: 'auto' })
  frame(connection, {
    type: 'system',
    subtype: 'init',
    uuid: 'haiku-root',
    model: 'claude-haiku-4-5',
    permissionMode: 'default'
  })
  const first = await send('ADMITTED prompt')
  await eventually(() => expect(written(connection, 'ADMITTED prompt')).toBeDefined())
  await eventually(() =>
    expect(host.collaboratorsForTests().conversationDelivery.loop.isRunning(SESSION)).toBe(false)
  )
  const admitted = (await snapshot()).submissions.find((entry) => entry.clientMessageId === first)!
  expect(admitted).toMatchObject({ dispatchState: 'pending', handedOverAt: expect.any(Number) })
  expect(host.currentWork(SESSION)?.owesSend(admitted)).toBe(true)
  expect(host.currentWork(SESSION)?.activeTurnId()).toBeNull()
  expect(adapter.holdsDispatch(SESSION)).toBe(false)

  const blocked = await send('BLOCKED transition', { model: 'opus' })
  await eventually(() =>
    expect(host.collaboratorsForTests().conversationDelivery.loop.isRunning(SESSION)).toBe(false)
  )
  expect(connection.closeCount).toBe(0)
  expect(connection.calls.some(({ subtype }) => subtype === 'set_model')).toBe(false)
  const submissions = (await snapshot()).submissions
  expect(submissions.find((entry) => entry.clientMessageId === blocked)).toMatchObject({
    dispatchState: 'rejected',
    rejection: {
      kind: 'restartFailed',
      refusal: { code: 'agent_session_operation_invalid', details: { reason: 'messagesUnsettled' } }
    }
  })
  expect(submissions.find((entry) => entry.clientMessageId === first)?.dispatchState).toBe(
    'pending'
  )
  expect(host.currentWork(SESSION)?.owesSend(admitted)).toBe(true)
  expect(written(connection, 'BLOCKED transition')).toBeUndefined()

  async function reply(on: FakeConnection, prompt: string, text: string, id: string) {
    const input = written(on, prompt)!
    frame(on, { ...input, isReplay: true, parent_tool_use_id: null })
    frame(on, {
      type: 'assistant',
      uuid: `assistant-${id}`,
      parent_tool_use_id: null,
      message: { id: `msg-${id}`, role: 'assistant', content: [{ type: 'text', text }] },
      user_message_uuid: input.uuid,
      user_message_uuids: [input.uuid]
    })
    frame(on, {
      type: 'result',
      subtype: 'success',
      uuid: `result-${id}`,
      is_error: false,
      terminal_reason: 'completed',
      result: text,
      user_message_uuid: input.uuid,
      user_message_uuids: [input.uuid]
    })
    frame(on, { type: 'system', subtype: 'session_state_changed', state: 'idle' })
    await eventually(async () => {
      expect(
        (await snapshot()).submissions.find((entry) => entry.clientMessageId === id)
      ).toMatchObject({ dispatchState: 'accepted' })
      expect(host.currentWork(SESSION)?.activeTurnId()).toBeNull()
    })
  }
  await reply(connection, 'ADMITTED prompt', 'Original result retained.', first)
  expect((await drawn()).map(({ text }) => text)).toContain('Original result retained.')
  expect(
    (await snapshot()).submissions.find((entry) => entry.clientMessageId === blocked)?.dispatchState
  ).toBe('rejected')

  const fresh = await send('FRESH transition', { model: 'opus' })
  await eventually(() => {
    expect(claude.connections).toHaveLength(2)
    expect(written(claude.connections[1]!, 'FRESH transition')).toBeDefined()
  })
  const resumed = claude.connections[1]!
  expect(connection.closeCount).toBe(1)
  expect(resumed.launch.options).toMatchObject({ model: 'opus', permissionMode: 'auto' })
  expect(store.getRecord(SESSION)?.providerHandleChain).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        handle: expect.objectContaining({ nativeId: PROVIDER_SESSION_ID })
      })
    ])
  )
  frame(resumed, {
    type: 'system',
    subtype: 'init',
    uuid: 'opus-root',
    model: 'claude-opus-4-6',
    permissionMode: 'default'
  })
  await reply(resumed, 'FRESH transition', 'First new-model reply.', fresh)
  const repeated = await send('REPEATED choice', { model: 'opus' })
  await eventually(() => expect(written(resumed, 'REPEATED choice')).toBeDefined())
  await reply(resumed, 'REPEATED choice', 'Second new-model reply.', repeated)
  expect(claude.connections).toHaveLength(2)
  expect(resumed.calls.some(({ subtype }) => subtype === 'set_model')).toBe(false)
  expect(claude.connections.some((child) => written(child, 'BLOCKED transition'))).toBe(false)
  expect((await drawn()).map(({ text }) => text)).toEqual(
    expect.arrayContaining([
      'Original result retained.',
      'First new-model reply.',
      'Second new-model reply.'
    ])
  )
})

it('holds a follow-up until the echo opens the turn, then folds it in, drawn inside that turn', async () => {
  const connection = claude.connections[0]!
  const first = await send('FIRST prompt')
  await eventually(() => expect(written(connection, 'FIRST prompt')).toBeDefined())
  const steer = await send('STEER prompt')
  await eventually(() =>
    expect(host.collaboratorsForTests().conversationDelivery.loop.isRunning(SESSION)).toBe(false)
  )

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

// Provider idle facts end acknowledgement waits; elapsed time cannot prove delivery.
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

// Keep delivery pending until Stop’s close proves exit; stopping is not yet uncertainty.
it('settles a send a Stop took before its echo, and the next message goes out', async () => {
  const connection = claude.connections[0]!
  const first = await send('FIRST prompt')
  await eventually(() => expect(written(connection, 'FIRST prompt')).toBeDefined())
  const close = connection.close
  let finishClose: (() => void) | undefined
  connection.close = () =>
    new Promise((resolve) => (finishClose = () => void close().then(resolve)))

  const stopped = stop()
  await eventually(() => expect(finishClose).toBeDefined())
  expect(
    host
      .currentWork(SESSION)
      ?.restatedSubmissions()
      .find((entry) => entry.clientMessageId === first)?.dispatchState
  ).toBe('pending')
  finishClose?.()
  expect(await stopped).toMatchObject({ ok: true, value: { cancelled: true } })
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

/** Reject writes from close start; inject unproven exit for the first failures attempts. */
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

/** Rows an older host wrote as it sent them, at the live child's fence: never answered, and the
 *  CLI holding none of them, unless each was accepted or refused as not signed in. */
async function olderHostSends(count: number, answer?: 'accepted' | 'notSignedIn'): Promise<void> {
  const journal = host.collaboratorsForTests().sessions.get(SESSION)!.journal
  const fence = store.getRecord(SESSION)!.lease.runtimeFence
  for (let index = 0; index < count; index += 1) {
    const clientMessageId = `older-${index}`
    const body = hostTestMessage(clientMessageId)
    await journal.appendSubmission({
      clientMessageId,
      payloadFingerprint: clientMessageId,
      body,
      fence
    })
    if (answer === 'accepted') {
      await journal.resolveDispatch({
        clientMessageId,
        fence,
        state: 'accepted',
        providerIdentity: null
      })
    } else if (answer === 'notSignedIn') {
      await journal.resolveDispatch({
        clientMessageId,
        fence,
        state: 'rejected',
        ...agentSessionFailureWords(agentSessionFailureFact(answer), { surface: 'rejection' })
      })
    }
  }
}

/** What the delivery loop's retirement checks read: the journal's history, wake debt (its only
 *  `newestTurn` reader there), and what the CLI holds, built by the adapter itself on each read. */
function countRetirementReads() {
  const journal = host.collaboratorsForTests().sessions.get(SESSION)!.journal
  const runningScans: { phase: string; visits: number }[] = []
  const counts = {
    checks: 0,
    linkageVisits: 0,
    submissionsCopied: 0,
    newestTurn: 0,
    heldSets: 0,
    heldVisits: 0,
    rejections: 0,
    runningScans,
    afterCheck: async (_check: number): Promise<void> => undefined
  }
  let inside = false
  let phase: string | null = null
  const running = vi.mocked(runningStructuredAgentSessionTurnItemBySequence)
  const originalRunning = running.getMockImplementation()!
  onTestFinished(() => void running.mockImplementation(originalRunning))
  running.mockImplementation((items) => {
    const scan = phase ? { phase, visits: 0 } : null
    if (scan) {
      counts.runningScans.push(scan)
    }
    return originalRunning({
      *[Symbol.iterator]() {
        for (const item of items) {
          if (scan) {
            scan.visits += 1
          }
          yield item
        }
      }
    })
  })
  const retire = vi.mocked(retireOutgrownStructuredAgentSessionChild)
  const actual = retire.getMockImplementation()!
  onTestFinished(() => void retire.mockImplementation(actual))
  retire.mockImplementation(async (...args) => {
    counts.checks += 1
    inside = true
    phase = `owner-${counts.checks}`
    try {
      return await actual(...args)
    } finally {
      inside = false
      phase = counts.checks === 2 ? 'turnScope' : null
      await counts.afterCheck(counts.checks)
    }
  })
  const { visitItemsWithLinkage, submissions, newestTurn } = journal
  journal.visitItemsWithLinkage = (visit) =>
    visitItemsWithLinkage((...item) => {
      counts.linkageVisits += inside ? 1 : 0
      visit(...item)
    })
  journal.submissions = () => {
    const all = submissions()
    counts.submissionsCopied += inside ? all.length : 0
    return all
  }
  journal.newestTurn = () => {
    counts.newestTurn += inside ? 1 : 0
    return newestTurn()
  }
  const resolveDispatch = journal.resolveDispatch.bind(journal)
  journal.resolveDispatch = (input, cards, receipt) => {
    counts.rejections += input.state === 'rejected' ? 1 : 0
    phase = null
    return resolveDispatch(
      input,
      cards,
      receipt && {
        ...receipt,
        write: (...args) => {
          phase = 'receipt.write'
          try {
            return receipt.write(...args)
          } finally {
            phase = null
          }
        }
      }
    )
  }
  const { heldSends } = adapter
  adapter.heldSends = (sessionId) => {
    const held = heldSends(sessionId)
    counts.heldSets += inside ? 1 : 0
    counts.heldVisits += inside ? (held?.size ?? 0) : 0
    return held
  }
  return counts
}

/** A person's pick of another permission mode, which writes the chat's record only. */
async function pickPermission(value: string): Promise<void> {
  const fields = { key: 'permissionMode', value }
  const picked = await host.setOption(CALLER, {
    envelope: {
      sessionId: SESSION,
      clientOperationId: hostTestOperationId(),
      expectedRuntimeFence: store.getRecord(SESSION)!.lease.runtimeFence,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.setOption',
        sessionId: SESSION,
        fields
      })
    },
    ...fields
  })
  expect(picked).toMatchObject({ ok: true })
}

// Each send is checked twice, before and after the wait for its child: the second check is what
// sees a change made during that wait, so it must stay, and stay one pass over history.
it('re-derives the retirement check after the wait, so a sign-out reported in it is honored', async () => {
  const connection = claude.connections[0]!
  const counts = countRetirementReads()
  counts.afterCheck = async (check) => (check === 1 ? olderHostSends(1, 'notSignedIn') : undefined)
  await send('CHANGED prompt')
  await eventually(() => expect(written(claude.connections[1]!, 'CHANGED prompt')).toBeDefined())
  expect(written(connection, 'CHANGED prompt')).toBeUndefined()
  expect(connection.closeCount).toBe(1)
})

describe.each([20, 200])('with %i earlier sends', (count) => {
  it('checks an ordinary send twice, each check one pass over history', async () => {
    await olderHostSends(count, 'accepted')
    const counts = countRetirementReads()
    await send('ORDINARY prompt')
    await eventually(() => expect(written(claude.connections[0]!, 'ORDINARY prompt')).toBeDefined())
    const { items, submissions } = await snapshot()
    expect(submissions).toHaveLength(count + 1)
    expect(counts).toMatchObject({
      checks: 2,
      linkageVisits: 2 * items.length,
      submissionsCopied: 2 * submissions.length,
      newestTurn: 0,
      heldSets: 0
    })
  })

  it('keeps an agent mid-turn through a permission change, deriving no wake debt', async () => {
    await olderHostSends(count, 'accepted')
    const connection = claude.connections[0]!
    await send('FIRST prompt')
    await eventually(() => expect(written(connection, 'FIRST prompt')).toBeDefined())
    frame(connection, {
      ...written(connection, 'FIRST prompt')!,
      isReplay: true,
      parent_tool_use_id: null
    })
    await eventually(() => expect(host.currentWork(SESSION)?.activeTurnId()).not.toBeNull())
    await pickPermission('ask')
    const counts = countRetirementReads()
    const dispatch = vi.spyOn(adapter, 'dispatch')
    await send('STEER prompt')
    await eventually(() => expect(written(connection, 'STEER prompt')).toBeDefined())
    expect(counts).toMatchObject({ checks: 2, newestTurn: 0 })
    const { items } = await snapshot()
    expect(counts.runningScans).toEqual(
      ['owner-1', 'owner-2', 'turnScope', 'receipt.write'].map((phase) => ({
        phase,
        visits: items.length
      }))
    )
    const addedScans = counts.runningScans.filter(({ phase }) => phase !== 'turnScope')
    expect(addedScans.reduce((total, scan) => total + scan.visits, 0)).toBe(3 * items.length)
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(
      connection.sent.filter((message) => JSON.stringify(message).includes('STEER prompt'))
    ).toHaveLength(1)
    expect(connection.closeCount).toBe(0)
  })

  // The 200-send case awaits journal writes and dispatches, so it has a larger test budget.
  it('refuses each queued model change behind an admitted send, reading what the CLI holds once per check', async () => {
    claudeFrames.initProof = 'none'
    const connection = claude.connections[0]!
    frame(connection, {
      type: 'system',
      subtype: 'init',
      uuid: 'haiku-root',
      model: 'claude-haiku-4-5',
      permissionMode: 'default'
    })
    await olderHostSends(count)
    const admitted = await send('ADMITTED prompt')
    await eventually(() => expect(written(connection, 'ADMITTED prompt')).toBeDefined())
    expect(adapter.holdsDispatch(SESSION)).toBe(false)
    const counts = countRetirementReads()
    const blocked: string[] = []
    for (let index = 0; index < count; index += 1) {
      blocked.push(await send(`BLOCKED ${index}`, { model: 'opus' }))
    }
    await eventually(async () => {
      const rejected = (await snapshot()).submissions.filter(
        (entry) => entry.dispatchState === 'rejected'
      )
      expect(rejected.map((entry) => entry.clientMessageId).sort()).toEqual([...blocked].sort())
    })
    // The admitted send is the one send the CLI holds, read once per check however many older
    // unanswered rows come before it.
    expect(counts).toMatchObject({
      checks: count,
      rejections: count,
      heldSets: count,
      heldVisits: count
    })
    expect(
      (await snapshot()).submissions.find((entry) => entry.clientMessageId === admitted)
    ).toMatchObject({ dispatchState: 'pending' })
    expect(connection.closeCount).toBe(0)
    expect(connection.calls.some(({ subtype }) => subtype === 'set_model')).toBe(false)
    expect(claude.connections).toHaveLength(1)
  }, 60_000)
})
