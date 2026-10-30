// Captured Claude 2.1.280 early-steer ordering: follow-ups wait for the opening echo before joining its turn.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, assert, beforeEach, expect, it, vi } from 'vitest'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import { agentSessionSendSubmission } from '../../../shared/agent-session-wire'
import { projectStructuredAgentSessionMessages } from '../../../shared/structured-agent-session-message-projection'
import { projectNativeChatTranscriptMessages } from '../../../shared/native-chat-transcript-projection'
import { nativeChatRowsInDrawOrder } from '../../../shared/native-chat/transcript/native-chat-turn-grouping'
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
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalMessageItem
} from '../../../shared/agent-session-journal-types'
import * as unheld from './structured-agent-session-unheld-turns'
import { claudeUnwrittenUserMessageError } from '../../claude/claude-agent-sdk-user-message-queue'

const CALLER = { callerKey: 'client-1' }
const CAPABILITIES = ['interrupt_receipt_v1', 'interrupt_cancel_queued_v1', 'msg_lifecycle_v1']

let root: string
let host: StructuredAgentSessionHost
let adapter: ClaudeStructuredSessionAdapter
let store: AgentSessionRecordStore
let claude: ReturnType<typeof fakeClaude>

let startupGate: ReturnType<typeof Promise.withResolvers<void>>
const session = () => host.collaboratorsForTests().sessions.get(SESSION)!
const loop = () => host.collaboratorsForTests().conversationDelivery.loop
const ready = () =>
  vi.waitFor(() => expect(host.readStatusSummary(SESSION)?.hostExecutionPhase).toBe('ready'))
const init = (fields: Record<string, unknown>) =>
  frame(claude.connections.at(-1)!, { type: 'system', subtype: 'init', ...fields })
const idle = () => init({ subtype: 'session_state_changed', state: 'idle' })
function echo() {
  const connection = claude.connections.at(-1)!
  frame(connection, { ...connection.sent.at(-1)!, isReplay: true, parent_tool_use_id: null })
}

beforeEach(async ({ task }) => {
  const imported = task.name.includes('history items')
  const selections = task.name.includes('fallback')
  startupGate = Promise.withResolvers<void>()
  root = await mkdtemp(join(tmpdir(), 'orca-claude-opening-send-'))
  resetHostTestOperationIds()
  const log = recordingStructuredAgentSessionLogger()
  claude = fakeClaude({
    replayUuid: null,
    ...(selections ? { initModel: 'claude-haiku-4-5' } : {}),
    routes: { interrupt: () => ({ still_queued: [], cancelled: [] }) }
  })
  const lifecycle: Promise<void>[] = []
  adapter = new ClaudeStructuredSessionAdapter({
    resolveLaunch: async ({ permissionMode }) => ({
      pathToClaudeCodeExecutable: 'claude',
      options: { permissionMode: permissionMode === 'auto' ? 'auto' : 'default' },
      cwd: root,
      claudeConfigDir: join(root, 'claude-home'),
      providerSessionId: PROVIDER_SESSION_ID,
      resumeLeafUuid: null,
      resumesTranscript: (store.getRecord(SESSION)?.providerHandleChain.length ?? 0) > 0,
      cliFlag: async () => 'supported' as const,
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
  if (imported) {
    const open = adapter.open.bind(adapter)
    vi.spyOn(adapter, 'open').mockImplementation(async (input) => {
      await startupGate.promise
      return open(input)
    })
  }
  const params = hostTestAttachParams(null, {
    provider: 'claude',
    agent: 'claude',
    ...(selections ? { options: { permissionMode: 'auto', model: 'haiku' } } : {}),
    accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: join(root, 'claude-home') },
    providerHandle: { kind: 'claude', sessionId: PROVIDER_SESSION_ID, leafUuid: null }
  })
  expect(await host.attach(CALLER, params)).toMatchObject({ ok: true })
  if (!imported) {
    await ready()
    await Promise.all(lifecycle)
  }
})

afterEach(async () => {
  startupGate.resolve()
  vi.restoreAllMocks()
  await adapter.closeAll()
  await host.flushAllStreamedEvents()
  await rm(root, { recursive: true, force: true })
})

const eventually = <T>(assertion: () => T | Promise<T>) =>
  vi.waitFor(assertion, { timeout: 10_000 })

async function send(
  text: string,
  options?: Record<string, string>,
  from?: AgentJournalMessageItem['from']
): Promise<string> {
  const body = { ...hostTestMessage(text), ...(from ? { from } : {}) }
  const sent = await host.send(CALLER, {
    envelope: {
      sessionId: SESSION,
      clientOperationId: hostTestOperationId(),
      expectedRuntimeFence: store.getRecord(SESSION)!.lease.runtimeFence,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.send',
        sessionId: SESSION,
        fields: { body: hostTestMessage(text), ...(options ? { options } : {}) }
      })
    },
    body,
    ...(options ? { options } : {})
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

async function sendChoice(
  text: string,
  options: Record<string, string>,
  from?: AgentJournalMessageItem['from']
) {
  await send(text, options, from)
  await eventually(() => expect(written(claude.connections.at(-1)!, text)).toBeDefined())
  echo()
  await host.flushStreamedEvents(SESSION)
  await eventually(() => expect(loop().isRunning(SESSION)).toBe(false))
}

it('preserves saved Auto through fallback, reopens once for a changed captured model, then reuses', async () => {
  const first = claude.connections[0]!
  init({ parent_tool_use_id: 'child', permissionMode: 'auto' })
  init({ permissionMode: 'default', model: 'claude-haiku-4-5' })
  init({ permissionMode: 'auto', model: 'claude-opus-5-5[1m]' })
  await sendChoice('same fallback', { model: 'haiku' })
  expect(claude.connections).toHaveLength(1)
  const picked = { model: 'opus[1m]', effort: 'high', fastMode: 'true' }
  await sendChoice('busy choice', picked)
  expect(claude.connections).toHaveLength(1)
  idle()
  await sendChoice('mail notice', picked, {
    kind: 'agent',
    senders: [],
    orchestration: {
      message: 'mail-notice',
      mailbox: 'agent:worker',
      dispatchId: null,
      messages: []
    }
  })
  expect(claude.connections).toHaveLength(1)
  idle()
  await sendChoice('new choice', picked)
  expect(first.closeCount).toBe(1)
  const replacement = claude.connections[1]!
  expect(replacement.launch.options).toMatchObject({
    permissionMode: 'auto',
    model: 'opus[1m]',
    effort: 'high'
  })
  expect(replacement.launch.options.settings).toEqual({ fastMode: true })
  idle()
  await sendChoice('reuse choice', picked)
  expect(claude.connections).toHaveLength(2)
  expect(replacement.sent).toHaveLength(2)
  expect(store.getRecord(SESSION)?.permissionMode).toBe('auto')
})

it('does not infer fallback from unknown init or a missing captured model', async () => {
  init({ model: 'claude-haiku-4-5' })
  init({ permissionMode: 'default' })
  await sendChoice('unknown permission', { model: 'opus[1m]' })
  expect(
    adapter.requiresModelTransitionRestart({
      sessionId: SESSION,
      fence: session().child!.fence
    })
  ).toBe(false)
  expect(claude.connections).toHaveLength(1)
})

it.each([10, 100])(
  'recovers imported running roots before readiness and drains waiting input once (%i history items)',
  async (n) => {
    const { journal, child } = session()
    expect(adapter.liveTurnId(SESSION)).toBeNull()
    const { fence, generation } = child!
    assert(typeof generation === 'string')
    const turn = (id: string, ownFence = fence, agentId?: string) =>
      journal.appendItem(
        { provider: 'claude', sessionId: PROVIDER_SESSION_ID, uuid: id },
        { kind: 'turn', turnId: id, state: 'running', startedAt: 1 },
        {
          fence,
          ownerFence: ownFence,
          turnScope: AGENT_JOURNAL_THREAD_SCOPE,
          ...(agentId ? { agentId } : {})
        }
      )
    for (let i = 0; i < n; i++) {
      await journal.appendItem(
        { provider: 'claude', sessionId: PROVIDER_SESSION_ID, uuid: `history-${i}` },
        {
          kind: 'message',
          role: 'assistant',
          blocks: [{ type: 'text', text: `Earlier reply ${i}` }]
        },
        { fence, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
      )
    }
    const stale = await turn('imported-root')
    const foreign = await turn('foreign-root', fence - 1)
    const subagent = await turn('child-root', fence, 'child')
    let visits = 0
    let scanning = false
    const settle = unheld.settleUnheldStructuredAgentSessionTurns
    const scans = vi
      .spyOn(unheld, 'settleUnheldStructuredAgentSessionTurns')
      .mockImplementation(async (...args) => {
        scanning = true
        try {
          await settle(...args)
        } finally {
          scanning = false
        }
      })
    const visit = journal.visitItemsWithLinkage.bind(journal)
    vi.spyOn(journal, 'visitItemsWithLinkage').mockImplementation((visitor) =>
      visit((...args) => {
        if (scanning) {
          visits++
        }
        visitor(...args)
      })
    )
    const batch = vi.spyOn(journal, 'appendPlannedLifecycleBatch')
    expect(await send('after the update')).toBeTruthy()
    expect(claude.connections[0]!.sent).toHaveLength(0)
    const before = visits
    startupGate.resolve()
    await ready()
    await vi.waitFor(() => expect(claude.connections[0]!.sent).toHaveLength(1))
    echo()
    await vi.waitFor(() => expect(journal.submissions()[0]?.dispatchState).toBe('accepted'))
    await vi.waitFor(() => expect(loop().isRunning(SESSION)).toBe(false))
    expect(journal.item(stale.itemId)?.body).toMatchObject({ state: 'interrupted' })
    expect(journal.item(foreign.itemId)?.body).toMatchObject({ state: 'running' })
    expect(journal.item(subagent.itemId)?.body).toMatchObject({ state: 'running' })
    expect(batch).toHaveBeenCalledTimes(1)
    expect(batch.mock.calls[0]![0].plan().mutations).toHaveLength(1)
    // Count the actual startup scan, independently of pre-existing current-work reads.
    expect(visits - before).toBe(n + 4)
    const reconcile = (liveId: string | null | undefined) =>
      unheld.settleUnheldStructuredAgentSessionTurns(journal, SESSION, fence, generation, liveId)
    const scanned = visits
    const cursor = journal.cursor()
    await reconcile(undefined)
    expect(visits).toBe(scanned)
    const live = adapter.liveTurnId(SESSION)
    expect(live).toBeTruthy()
    await reconcile(live)
    expect(journal.cursor()).toEqual(cursor)
    expect(batch).toHaveBeenCalledTimes(1)
    const scanCount = scans.mock.calls.length
    const finalVisits = visits
    idle()
    await host.flushStreamedEvents(SESSION)
    expect(scans).toHaveBeenCalledTimes(scanCount)
    expect(visits).toBe(finalVisits)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(claude.connections[0]!.sent).toHaveLength(1)
    expect(host.currentWork(SESSION)?.activeTurnId()).toBeNull()
    expect(host.readStatusSummary(SESSION)?.status).not.toBe('working')
  }
)
