import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import {
  createClaudeUserMessageQueue,
  claudeUserMessageWasProvablyUnwritten
} from '../../claude/claude-agent-sdk-user-message-queue'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ClaudeStructuredSessionAdapter } from '../../claude/claude-structured-session-adapter'
import { fakeClaude } from '../../claude/claude-structured-session-test-support'
import { claudeStructuredPermissionOptions } from '../../claude/claude-structured-launch-resolution'
import { structuredClaudeLifecycleEvent } from '../../runtime/structured-claude-runtime-adapter'
import { createRestTestRig } from './structured-agent-session-rest-test-rig'
import {
  claudeAndCodexDeclared,
  claudeAndCodexRouter
} from './structured-agent-session-adapter-router-test-support'
import { recordingStructuredAgentSessionLogger } from './structured-agent-session-logger-test-support'
import {
  HOST_TEST_SESSION as SESSION,
  hostTestAttachParams,
  hostTestMessage,
  hostTestOperationId
} from './structured-agent-session-host-test-data'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import { structuredAgentSessionProviderRetryPending } from './structured-agent-session-provider-retry'
import type { StructuredAgentSessionHost } from './structured-agent-session-host'
import { OrchestrationDb } from '../../runtime/orchestration/db'
import { createRootDispatch } from '../../runtime/orchestration/db/root-dispatch-test-fixture'
import { escalateChatWorkerError } from '../../runtime/orchestration/chat-worker-error-escalation'
import { chatRequestError } from '../../runtime/orchestration/chat-worker-error-words'
import {
  structuredWorkerIdentities,
  mintStructuredWorkerHandle,
  mintStructuredWorkerPaneKey
} from '../../runtime/structured-worker-identity'
import type { StructuredAgentSessionRequestFailure } from './structured-agent-session-request-failures'

const bytes = readFileSync(
  join(__dirname, '../../claude/__fixtures__/claude-lifecycle-capture-api-overloaded.jsonl')
)
const capture: Record<string, unknown>[] = bytes
  .toString('utf8')
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line))
const sessionId = String(capture[0]!.session_id)
const rootUuid = String(capture[0]!.uuid)
const CALLER = { callerKey: 'client-1' }
let ownedRig: Awaited<ReturnType<typeof createRestTestRig>> | undefined
let host: StructuredAgentSessionHost
let adapter: ClaudeStructuredSessionAdapter
let claude: ReturnType<typeof fakeClaude>
let recoveryOperations: Promise<unknown>[] = []
function trackRecoveryOperation(operation: Promise<unknown> | undefined): void {
  if (!operation) {
    return
  }
  recoveryOperations.push(operation)
  void operation.catch(() => undefined)
}
async function drainRecoveryOperations(): Promise<void> {
  const failures: unknown[] = []
  do {
    for (const result of await Promise.allSettled(recoveryOperations.splice(0))) {
      if (result.status === 'rejected') {
        failures.push(result.reason)
      }
    }
  } while (recoveryOperations.length > 0)
  if (failures.length > 0) {
    throw new AggregateError(failures, 'fixture recovery operations failed')
  }
}
beforeEach(async () => {
  ownedRig = undefined
  claude = fakeClaude({ initSessionId: sessionId, replayUuids: [rootUuid, 'hidden-replay'] })
  adapter = new ClaudeStructuredSessionAdapter({
    resolveLaunch: async ({ permissionMode }) => ({
      pathToClaudeCodeExecutable: 'claude',
      options: claudeStructuredPermissionOptions(permissionMode ?? 'ask'),
      cwd: '/work/repo',
      claudeConfigDir: '/qa/claude',
      providerSessionId: sessionId,
      resumeLeafUuid: null,
      resumesTranscript: false,
      cliFlag: async () => 'supported' as const,
      continuesChain: false
    }),
    openConnection: claude.openConnection,
    onEvent: (event) => {
      const mapped = structuredClaudeLifecycleEvent(event)
      if (mapped) {
        trackRecoveryOperation(host.handleAdapterEvent(mapped))
      }
    },
    onDispatchSettledLate: (value) => trackRecoveryOperation(host.settleLateDispatch(value)),
    readProcessStartTime: async () => 1_700_000_000_000
  })
  const router = claudeAndCodexRouter({ claude: adapter, codex: adapter }, () => adapter.closeAll())
  const rig = await createRestTestRig(
    {
      agents: claudeAndCodexDeclared(),
      adapter: router,
      logger: recordingStructuredAgentSessionLogger().logger,
      probeOwner: undefined,
      statusSink: undefined,
      idleSweep: undefined
    },
    {
      scoped: true,
      closeAdapter: () => adapter.closeAll(),
      waitForRecovery: drainRecoveryOperations
    }
  )
  ownedRig = rig
  void rig.root
  host = rig.host
  expect(
    await host.attach(
      CALLER,
      hostTestAttachParams(null, {
        provider: 'claude',
        agent: 'claude',
        accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: '/qa/claude' },
        providerHandle: { kind: 'claude', sessionId, leafUuid: null }
      })
    )
  ).toMatchObject({ ok: true })
  await vi.waitFor(() => expect(host.readStatusSummary(SESSION)?.hostExecutionPhase).toBe('ready'))
})
afterEach(async () => {
  const current = ownedRig
  ownedRig = undefined
  vi.useRealTimers()
  try {
    await current?.dispose()
  } finally {
    vi.restoreAllMocks()
  }
})

function envelope(method: string, fields: Record<string, unknown>) {
  return {
    sessionId: SESSION,
    clientOperationId: hostTestOperationId(),
    expectedRuntimeFence: null,
    payloadFingerprint: computeAgentSessionPayloadFingerprint({
      method,
      sessionId: SESSION,
      fields
    })
  }
}
async function send(text: string, options?: Record<string, string>) {
  const fields = { body: hostTestMessage(text), ...(options ? { options } : {}) }
  const params = {
    envelope: envelope('agentSession.send', fields),
    userSend: true as const,
    ...fields
  }
  const result = await host.send(CALLER, params)
  if (!result.ok) {
    throw new Error(JSON.stringify(result.refusal))
  }
  const id = result.value.clientMessageId
  const receipt = host.deps.store.readCommandReceipt({ kind: 'global' }, id)
  expect(receipt).toMatchObject({
    verdict: 'readable',
    receipt: { status: 'accepted', method: 'agentSession.send' }
  })
  expect(await host.send(CALLER, params)).toMatchObject({
    ok: true,
    replayed: true,
    value: { clientMessageId: id }
  })
  expect(host.deps.store.readCommandReceipt({ kind: 'global' }, id)).toEqual(receipt)
  expect(host.collaboratorsForTests().sessions.get(SESSION)!.journal.submission(id)).toBeDefined()
  return id
}
async function failCaptured(beforeFrames?: () => void) {
  const message = capture[0]!.message
  if (
    !message ||
    typeof message !== 'object' ||
    !('content' in message) ||
    typeof message.content !== 'string'
  ) {
    throw new Error('capture opener missing')
  }
  await send(message.content, { model: 'claude-sonnet' })
  await vi.waitFor(async () =>
    expect((await host.journalSnapshot(SESSION)).submissions[0]?.dispatchState).toBe('accepted')
  )
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  beforeFrames?.()
  // Exact captured objects and order, including success subtype with is_error and numeric 529.
  for (const frame of capture) {
    claude.connections[0]!.handlers.onMessage?.(frame)
  }
  if (!beforeFrames) {
    await host.flushStreamedEvents(SESSION)
  }
}
it('keeps a genuinely refused Claude result unsafe for resume and starts no automatic work without a committed terminal', async () => {
  const runtime = host.collaboratorsForTests().runtimeState
  const deferred = runtime.currentEventSink(SESSION)!
  const journal = host.collaboratorsForTests().sessions.get(SESSION)!.journal
  await failCaptured(() => {
    deferred.unbind()
    for (let index = 0; index < 1_024; index++) {
      expect(
        deferred.sink.tryAppendItem?.(
          { provider: 'legacy', agent: 'claude', sessionId: SESSION, recordId: 'pressure' },
          { kind: 'status', text: `pressure-${index}` },
          { lifecycle: true, turnScope: { kind: 'thread' } }
        )
      ).toEqual({ accepted: true })
    }
  })
  const session = adapter['sessions'].get(SESSION)!
  expect(session.translator?.finalOutputAdmitted).toBe(false)
  expect(structuredAgentSessionProviderRetryPending(journal)).toBe(false)
  deferred.bind({
    journal,
    fence: session.fence,
    publish: () => host['subscribers'].publish(SESSION, journal)
  })
  await deferred.drained()
  await vi.advanceTimersByTimeAsync(60_000)
  expect(claude.connections[0]!.sent.filter((frame) => frame.type === 'user')).toHaveLength(1)
  expect(session.resumePointWrite).toBeUndefined()
  // Use the ordinary exit/close recovery; refusal does not introduce a result replay owner.
  claude.connections[0]!.handlers.onExit?.(new Error('provider exited after refused final output'))
  await adapter.drainObservedExits()
  await host.flushAllStreamedEvents()
  expect(structuredAgentSessionProviderRetryPending(journal)).toBe(false)
})
it('settles genuine 2.1.312 numeric 529 through adapter/result/turn writer, then continues only after the hidden replay', async () => {
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(
    '3c3fa873279c2453b6c6e02b8c514f811eb0dac60652eaeeee510efca1765206'
  )
  await failCaptured()
  const journal = host.collaboratorsForTests().sessions.get(SESSION)!.journal
  expect(
    journal.snapshot().items.some((item) => readAgentJournalTurn(item.body)?.outcome === 'failure')
  ).toBe(true)
  expect(host.readStatusSummary(SESSION)?.status).toBe('working')
  await vi.advanceTimersByTimeAsync(2_000)
  const sent = claude.connections[0]!.sent.filter((frame) => frame.type === 'user')
  expect(sent).toHaveLength(2)
  expect(sent[1]).toMatchObject({
    message: { content: [{ type: 'text', text: 'Please continue.' }] }
  })
  claude.connections[0]!.handlers.onMessage?.({
    type: 'result',
    subtype: 'success',
    is_error: false,
    session_id: sessionId,
    uuid: 'completed-hidden',
    result: 'done',
    duration_ms: 10
  })
  await host.flushStreamedEvents(SESSION)
  expect(host.readStatusSummary(SESSION)).toMatchObject({ status: 'idle', turnOutcome: 'success' })
  expect(
    journal
      .snapshot()
      .items.filter((item) => item.body.kind === 'message' && item.body.role === 'user')
  ).toHaveLength(1)
})
it('reads a released Claude hidden result after its real post-terminal diagnostic commits', async () => {
  const db = new OrchestrationDb(':memory:')
  const worker = structuredWorkerIdentities.register({
    handle: mintStructuredWorkerHandle(),
    sessionId: SESSION,
    agent: 'claude',
    paneKey: mintStructuredWorkerPaneKey(SESSION),
    processIncarnation: `structured:${SESSION}`,
    worktreeId: 'workspace-1',
    hostScope: { kind: 'local', hostId: 'local' }
  })
  const run = db.createRun({
    objective: 'released result evidence',
    coordinatorHandle: 'term_coord',
    coordinatorPaneKey: 'tab:11111111-1111-4111-8111-111111111111'
  })
  createRootDispatch(
    db,
    db.createTask({ spec: 'work', runId: run.id }).id,
    worker.handle,
    worker.paneKey
  )
  const requests: StructuredAgentSessionRequestFailure[] = []
  const pending: Promise<void>[] = []
  const notify = vi.fn<(handle: string, messageType: string) => void>()
  const order: string[] = []
  const previous = host.deps.onRequestFailure
  const journal = host.collaboratorsForTests().sessions.get(SESSION)!.journal
  const committed = journal['onCommitted']
  const originalRead = journal.readInOrder
  const readInOrder = originalRead.bind(journal)
  const captureReadSource = journal.captureReadSource
  const snapshot = journal.snapshot
  let materializing: StructuredAgentSessionRequestFailure['read'] | undefined
  const materializations: {
    read: StructuredAgentSessionRequestFailure['read']
    snapshot: ReturnType<typeof journal.snapshot>
  }[] = []
  const sentence = 'The exact hidden result failed: diagnostic detail saved after terminal.'
  host.deps.onRequestFailure = (request) => {
    previous?.(request)
    requests.push(request)
    expect(readAgentJournalTurn(journal.itemBody(request.id) ?? undefined)?.state).toBe('completed')
    order.push('terminal-release')
    pending.push(
      escalateChatWorkerError(request, { getDb: () => db, isWaitingForMail: () => false, notify })
    )
  }
  const release = journal.observeCommits((rows, applied) => {
    committed?.(rows, applied)
    if (
      rows?.some(
        (row) => row.kind === 'item' && row.body.kind === 'status' && row.body.text === sentence
      )
    ) {
      order.push('diagnostic-commit')
    }
  })
  journal.captureReadSource = () => {
    const currentSource = captureReadSource()
    return () => {
      const current = currentSource()
      if (current) {
        materializing =
          host['clientDelivery'].requestFailures['baselines'].get(SESSION)?.releasedRead?.read
      }
      return current
    }
  }
  journal.readInOrder = <T>(read: () => T): Promise<T> =>
    readInOrder(() => {
      const previousMaterializing = materializing
      materializing = undefined
      try {
        return read()
      } finally {
        materializing = previousMaterializing
      }
    })
  journal.snapshot = () => {
    const value = snapshot()
    if (materializing) {
      materializations.push({ read: materializing, snapshot: value })
      order.push('materialize')
    }
    return value
  }
  try {
    await failCaptured()
    expect(requests).toHaveLength(0)
    expect(db.getUnreadRunMailbox(run.id, 100, ['escalation'])).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(2_000)
    await host.flushStreamedEvents(SESSION)
    const sent = claude.connections[0]!.sent.filter((frame) => frame.type === 'user')
    expect(sent).toHaveLength(2)
    expect(sent[1]).toMatchObject({
      message: { content: [{ type: 'text', text: 'Please continue.' }] }
    })
    const hidden = journal.runningTurn()!.item
    expect(host['providerRetry']['retries'].get(SESSION)?.currentResult?.itemId).toBe(hidden.itemId)
    order.length = 0
    claude.connections[0]!.handlers.onMessage?.({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      session_id: sessionId,
      uuid: 'result-only-hidden-failure',
      api_error_status: 400,
      result: sentence,
      duration_ms: 10
    })
    await host.flushStreamedEvents(SESSION)
    await Promise.all(pending)
    expect(requests).toMatchObject([{ id: hidden.itemId, outcome: 'failure' }])
    expect(order).toEqual(['terminal-release', 'diagnostic-commit', 'materialize'])
    expect(materializations).toHaveLength(1)
    expect(materializations[0]!.read).toBe(requests[0]!.read)
    expect(chatRequestError(materializations[0]!.snapshot, requests[0]!)?.text).toBe(sentence)
    const saved = chatRequestError(journal.snapshot(), requests[0]!)
    expect(saved?.text).toBe(sentence)
    const mail = () => db.getUnreadRunMailbox(run.id, 100, ['escalation'])
    expect(mail()).toHaveLength(1)
    expect(mail()[0]?.body).toContain(`Error: ${sentence}`)
    expect(JSON.parse(mail()[0]!.payload ?? '{}')).toMatchObject({
      requestId: hidden.itemId,
      error: sentence
    })
    expect(notify).toHaveBeenCalledOnce()
    expect(structuredAgentSessionProviderRetryPending(journal)).toBe(false)
    expect(
      host['clientDelivery'].requestFailures['baselines'].get(SESSION)?.releasedRead
    ).toBeUndefined()
    await vi.advanceTimersByTimeAsync(90_000)
    expect(claude.connections[0]!.sent.filter((frame) => frame.type === 'user')).toHaveLength(2)
    expect(requests).toHaveLength(1)
    expect(mail()).toHaveLength(1)
  } finally {
    host.deps.onRequestFailure = previous
    journal.readInOrder = originalRead
    journal.captureReadSource = captureReadSource
    journal.snapshot = snapshot
    release()
    journal['onCommitted'] = committed
    try {
      await Promise.all(pending)
    } finally {
      structuredWorkerIdentities.forget(worker.handle)
      db.close()
    }
  }
})
it.each(['preparation', 'replay'] as const)(
  'accepts new input while hidden Claude %s is held and never revives the old claim',
  async (phase) => {
    await failCaptured()
    const connection = claude.connections[0]!
    const held = Promise.withResolvers<void>()
    const original = connection.send.bind(connection)
    if (phase === 'preparation') {
      // Ordinary option preparation, held outside host serialization.
      const session = adapter['sessions'].get(SESSION)!
      session.appliedInputOptions.clear()
      claude.routes.set_model = () => held.promise
    } else {
      connection.send = async (message, authorize) => {
        const body = message.message
        const hidden =
          body &&
          typeof body === 'object' &&
          'content' in body &&
          Array.isArray(body.content) &&
          body.content.some(
            (value) =>
              typeof value === 'object' &&
              value !== null &&
              'text' in value &&
              value.text === 'Please continue.'
          )
        if (message.type === 'user' && hidden) {
          await authorize?.()
          connection.sent.push(message)
          await held.promise
          connection.handlers.onMessage?.({ ...message, uuid: 'late-hidden-replay' })
        } else {
          await original(message, authorize)
        }
      }
    }
    await vi.advanceTimersByTimeAsync(2_000)
    const id = await send('accepted before the hidden wait ends')
    const journal = host.collaboratorsForTests().sessions.get(SESSION)!.journal
    expect(host.deps.store.readCommandReceipt({ kind: 'global' }, id)).toMatchObject({
      verdict: 'readable',
      receipt: { status: 'accepted' }
    })
    expect(structuredAgentSessionProviderRetryPending(journal)).toBe(false)
    held.resolve()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(
      connection.sent.filter((frame) => JSON.stringify(frame).includes('Please continue.')).length
    ).toBeLessThanOrEqual(1)
    await vi.waitFor(() => expect(journal.receiptFor(id)).not.toBeNull())
  }
)

it.each([
  'stop',
  'supersession',
  'permission',
  'queue-fail',
  'callback-fail',
  'uncertain'
] as const)(
  'authorizes hidden Claude input at the real SDK dequeue after %s, with bounded settlement',
  async (change) => {
    await failCaptured()
    const connection = claude.connections[0]!
    const originalSend = connection.send.bind(connection)
    const queue = createClaudeUserMessageQueue()
    const pump = queue.messages[Symbol.asyncIterator]()
    const prior = queue
      .push({
        type: 'user',
        message: { role: 'user', content: 'prior transport frame' },
        parent_tool_use_id: null,
        session_id: sessionId
      })
      .catch((error: unknown) => error)
    expect(await pump.next()).toMatchObject({
      value: { message: { content: 'prior transport frame' } }
    })
    const writes: Promise<void>[] = []
    const enteredAuthorization = Promise.withResolvers<void>()
    const queued = vi.fn(
      (message: Record<string, unknown>, beforeDispatch?: () => Promise<void>) => {
        const write = queue.push(
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the real adapter built this SDK user envelope; this is the production transport's same queue boundary.
          message as unknown as SDKUserMessage,
          beforeDispatch
            ? () => {
                enteredAuthorization.resolve()
                return beforeDispatch()
              }
            : undefined
        )
        writes.push(write)
        void write.catch(() => {})
        return write
      }
    )
    connection.send = queued
    const journal = host.collaboratorsForTests().sessions.get(SESSION)!.journal
    try {
      await vi.advanceTimersByTimeAsync(2_000)
      await vi.waitFor(() => expect(queued).toHaveBeenCalledOnce())
      expect(connection.sent.filter((frame) => frame.type === 'user')).toHaveLength(1)
      let fresh: string | undefined
      if (change === 'stop') {
        expect(
          await host.cancel(CALLER, { envelope: envelope('agentSession.cancel', {}) })
        ).toMatchObject({ ok: true })
        expect(connection.closeCount).toBe(0)
        expect(host.readStatusSummary(SESSION)?.turnOutcome).toBe('cancellation')
      } else if (change === 'supersession') {
        fresh = await send('fresh accepted input before hidden dequeue')
        expect(host.deps.store.readCommandReceipt({ kind: 'global' }, fresh)).toMatchObject({
          verdict: 'readable',
          receipt: { status: 'accepted' }
        })
        await vi.waitFor(() => expect(queued).toHaveBeenCalledTimes(2))
      } else if (change === 'permission') {
        const fields = { key: 'permissionMode', value: 'full-access' }
        expect(
          await host.setOption(CALLER, {
            envelope: envelope('agentSession.setOption', fields),
            ...fields
          })
        ).toMatchObject({ ok: true })
      } else if (change === 'queue-fail') {
        queue.fail(new Error('transport failed while the hidden frame was still queued'))
      }
      if (change === 'callback-fail') {
        const releaseOrdering = Promise.withResolvers<void>()
        const ordered = host
          .collaboratorsForTests()
          .serialize(SESSION, () => releaseOrdering.promise)
        const next = pump.next()
        await enteredAuthorization.promise
        queue.fail(new Error('transport failed while ordinary authorization awaited ordering'))
        queue.end()
        releaseOrdering.resolve()
        await ordered
        expect(await next).toMatchObject({ done: true })
        expect(
          claudeUserMessageWasProvablyUnwritten(await writes[0]!.catch((error: unknown) => error))
        ).toBe(true)
      }
      if (change === 'uncertain') {
        const yielded = await pump.next()
        expect(yielded.value).toMatchObject({
          message: { content: [{ type: 'text', text: 'Please continue.' }] }
        })
        queue.fail(new Error('transport outcome unknown after SDK handoff'))
        expect(
          claudeUserMessageWasProvablyUnwritten(await writes[0]!.catch((error: unknown) => error))
        ).toBe(false)
      }
      queue.end()
      const yielded: unknown[] = []
      for (;;) {
        const next = await pump.next()
        if (next.done) {
          break
        }
        yielded.push(next.value)
        await originalSend(next.value)
      }
      await prior
      await Promise.allSettled(writes)
      await host.flushStreamedEvents(SESSION)
      expect(yielded.some((frame) => JSON.stringify(frame).includes('Please continue.'))).toBe(
        false
      )
      if (change === 'queue-fail') {
        expect(
          claudeUserMessageWasProvablyUnwritten(await writes[0]!.catch((error: unknown) => error))
        ).toBe(true)
      }
      if (fresh) {
        await vi.waitFor(() => expect(journal.submission(fresh!)?.dispatchState).toBe('accepted'))
        expect(yielded).toHaveLength(1)
        expect(journal.receiptFor(fresh)).not.toBeNull()
      }
      await vi.advanceTimersByTimeAsync(60_000)
      expect(structuredAgentSessionProviderRetryPending(journal)).toBe(false)
      expect(
        queued.mock.calls.filter(([frame]) => JSON.stringify(frame).includes('Please continue.'))
      ).toHaveLength(1)
    } finally {
      queue.fail(new Error('test queue closed'))
      queue.end()
      await pump.return?.()
      await Promise.allSettled(writes)
      await prior
      connection.send = originalSend
    }
  }
)
