import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as hostInstaller from '../../structured-agent-session-runtime'
import { partialRuntimeStore } from '../../runtime-store-partial-fixture'
import { StructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-host'
import { computeAgentSessionPayloadFingerprint } from '../../../../shared/agent-session-mutation-envelope'
import { MailDebts } from '../../orchestration/structured-mail-source-discovery'
import { MessageWaitScope } from '../../runtime-message-waiters'
import { ordinaryMailCreationId } from '../../orchestration/structured-mailbox-pointer-delivery'
import { observeMailSqlWork } from '../../orchestration/mail-sql-work.test-support'
import { mailCheckTransport } from '../../orchestration/mail-check-transport.test-fixture'
import { queuedMessagesPublishedBytes } from '../../../native-chat/agent-session-wire/structured-agent-session-queued-published-bytes'
import {
  agentJournalSubmissionKey,
  AGENT_JOURNAL_THREAD_SCOPE
} from '../../../../shared/agent-session-journal-types'
import {
  hostTestState,
  replaceHostTestState
} from '../../../native-chat/agent-session-wire/structured-agent-session-host-test-harness'
import { createTestParams } from '../../../native-chat/agent-session-wire/structured-agent-session-create-test-fixture'
import {
  hostTestMessage,
  hostTestOperationId
} from '../../../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import {
  structuredWorkerIdentities,
  type StructuredWorkerIdentity
} from '../../structured-worker-identity'
import { createOrchestrationRpcHarness } from './orchestration/rpc-test-harness'
import { releaseStructuredWorkerSession } from './orchestration-structured-worker-session'
import { idOf } from '../orchestration-session-caller-test-fixture'
import { createStructuredWorkerSessionForWorktree } from './orchestration/worker/worker-topology'

vi.mock('./structured-agent-session-create', () => ({
  createStructuredAgentSessionForWorktree: async (args: { envelope: { sessionId: string } }) => {
    const { host } = hostTestState()
    return host.create(
      { callerKey: 'redrive-test' },
      createTestParams(undefined, {
        envelope: {
          ...args.envelope,
          clientOperationId: hostTestOperationId(),
          expectedRuntimeFence: null,
          payloadFingerprint: '0'.repeat(64)
        }
      })
    )
  }
}))

const harness = createOrchestrationRpcHarness()
let state: ReturnType<typeof harness.setup>
let dispatchId: string
let dispatchIds: string[]

function createDispatch() {
  const task = state.db.createTask({ spec: 'redrive test' })
  const id = state.db.createStartingWorkerDispatch({
    creator: { kind: 'system' },
    maxDepth: 10,
    taskId: task.id,
    startOptions: {}
  }).dispatch.id
  dispatchIds.push(id)
  return id
}

beforeEach(async () => {
  vi.useFakeTimers()
  structuredWorkerIdentities.clear()
  state = harness.setup(true, partialRuntimeStore())
  // Exercise the real process-listing factory. Only its adapter/store installation boundary is a fixture.
  vi.spyOn(hostInstaller, 'ensureStructuredAgentSessionHost').mockImplementation(async (deps) => {
    const prior = hostTestState()
    prior.host.stopDelivery()
    const installed = new StructuredAgentSessionHost({
      ...prior.host.deps,
      captureSessionMail: deps.captureSessionMail,
      onSessionMailActivity: deps.onSessionMailActivity,
      onSessionStatusChanged: deps.onSessionStatusChanged,
      onRequestFailure: deps.onRequestFailure
    })
    replaceHostTestState({ store: prior.store, host: installed })
    return installed
  })
  await state.runtime.ensureStructuredAgentSessionHost()
  vi.spyOn(state.runtime, 'ensureStructuredAgentSessionHost').mockResolvedValue(undefined)
  const { host, store, acquire } = hostTestState()
  const acquireImpl = acquire.getMockImplementation()
  if (!acquireImpl) {
    throw new Error('Fixture acquisition is missing')
  }
  acquire.mockImplementation(async (input) => {
    const acquired = await acquireImpl(input)
    if (!acquired.link) {
      throw new Error('Fixture acquisition has no provider link')
    }
    return {
      ...acquired,
      link: {
        ...acquired.link,
        origin: store.getRecord(input.identity.sessionId)?.providerHandleChain.length
          ? 'resumed'
          : 'created'
      }
    }
  })
  setStructuredAgentSessionHost(host)
  dispatchIds = []
  dispatchId = createDispatch()
})

afterEach(() => {
  for (const id of dispatchIds) {
    releaseStructuredWorkerSession(id, state.runtime)
  }
  vi.useRealTimers()
  harness.cleanup()
  setStructuredAgentSessionHost(null)
  structuredWorkerIdentities.clear()
  vi.restoreAllMocks()
})

function workerJournal(identity: StructuredWorkerIdentity) {
  const { host, store } = hostTestState()
  const journal = host.queuedMailJournal(identity.sessionId)
  if (!journal) {
    throw new Error('Worker did not open its journal')
  }
  const fence = store.requireWritableRecord(identity.sessionId).lease.runtimeFence
  const append = (text: string) =>
    journal.appendItem(
      { provider: 'orca', clientMessageId: text },
      { kind: 'status', text },
      { fence, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
  return { host, store, journal, fence, identity, append }
}

it.each([100, 1000])(
  'installed worker semantic feed bounds U=%i pressure debt, new tails, capacity wakes and full turns',
  async (count) => {
    vi.useRealTimers()
    const { host, store, dispatch } = hostTestState()
    const { identity } = await createStructuredWorkerSessionForWorktree({
      runtime: state.runtime,
      worktreeId: 'workspace-1',
      agent: 'codex',
      dispatchId,
      effects: []
    })
    const worker = workerJournal(identity)
    state.db.prepareStartingWorkerAuthority({
      dispatchId,
      handle: identity.handle,
      paneKey: identity.paneKey,
      processIncarnation: identity.processIncarnation,
      worktreeId: 'workspace-1',
      effects: [],
      setupState: 'not_applicable'
    })
    state.db.markWorkerDispatchReady(dispatchId)
    const mailbox = `dispatch:${dispatchId}`
    const command = (method: string, fields: Record<string, unknown>) => ({
      sessionId: identity.sessionId,
      clientOperationId: hostTestOperationId(),
      expectedRuntimeFence: worker.fence,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method,
        sessionId: identity.sessionId,
        fields
      })
    })
    const turn = { provider: 'orca', clientMessageId: 'active-turn' } as const
    await worker.journal.appendItem(
      turn,
      { kind: 'turn', turnId: 'active-turn', state: 'running' },
      { fence: worker.fence, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    const personal: string[] = []
    for (let n = 0; n < 4; n++) {
      const fields = {
        body: hostTestMessage('p'.repeat(200000)),
        delivery: 'queue-if-active' as const
      }
      const envelope = command('agentSession.send', fields)
      expect(
        await host.send({ callerKey: 'real-client' }, { ...fields, userSend: true, envelope })
      ).toMatchObject({ ok: true, value: { queued: {} } })
      personal.push(envelope.clientOperationId)
    }
    const compact = { command: 'compact' as const, delivery: 'queue-if-active' as const }
    expect(
      await host.conversationCommand(
        { callerKey: 'real-client' },
        {
          ...compact,
          envelope: command('agentSession.conversationCommand', compact)
        }
      )
    ).toMatchObject({ ok: true, value: { queued: {} } })
    const moved = state.db.insertMessage({
      runId: state.db.getDispatchContextById(dispatchId)!.run_id,
      from: 'term_coord',
      to: 'unbound-direct-input',
      subject: 'old-ID route'
    })
    const scope = new MessageWaitScope()
    const waiting = state.runtime.waitForMessage(mailbox, { scope, timeoutMs: 60000 })
    const sourceWork = observeMailSqlWork(
      state.db.db,
      (sql) => sql.includes('ORDER BY sequence LIMIT 50') && sql.includes('delivered_at IS NULL'),
      'sequence',
      true
    )
    const receipts = vi.spyOn(store, 'readCommandReceipt')
    const bodies = vi.spyOn(state.db, 'getMessageById')
    const attempts = vi.spyOn(host, 'send')
    const bytes = vi.spyOn(Buffer, 'byteLength')
    const queueBodyWork = () =>
      bytes.mock.calls.reduce(
        (sum, [value]) =>
          sum +
          (typeof value === 'string' &&
          value.startsWith('{"kind":"message","role":"user","blocks":')
            ? 1
            : 0),
        0
      )
    const sources = []
    for (let n = 0; n < count; n++) {
      sources.push(
        idOf(
          (
            await harness.call(
              'orchestration.send',
              { from: 'term_coord', to: mailbox, subject: `report-${n}` },
              state.ctx
            )
          ).message
        )
      )
    }
    expect(await waiting).toBe('notified')
    state.runtime.deliverPendingMessagesForHandle(mailbox)
    scope.complete()
    await vi.waitFor(() => expect(attempts).toHaveBeenCalledTimes(count), { timeout: 20000 })
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(
      state.db.db
        .prepare('SELECT count(*) AS n FROM messages WHERE to_handle = ? AND delivered_at IS NULL')
        .get(mailbox)?.n
    ).toBe(count)
    const baseline = {
      receipts: receipts.mock.calls.length,
      bodies: bodies.mock.calls.length,
      attempts: attempts.mock.calls.length,
      visits: sourceWork.count(),
      queueBodySerializations: queueBodyWork()
    }
    expect(sourceWork.count()).toBe(count)
    expect(sourceWork.calls.reduce((sum, call) => sum + call.bytes, 0)).toBeLessThan(count * 700)
    expect(baseline.receipts).toBeLessThan(count * 6 + 20)
    expect(baseline.bodies).toBe(count)
    const beforeBytes = queuedMessagesPublishedBytes(worker.journal)
    for (let n = 0; n < 10; n++) {
      await worker.append(`separated-token-${n}`)
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    for (let n = 0; n < 30; n++) {
      await worker.append(`sustained-token-${n}`)
    }
    expect({
      receipts: receipts.mock.calls.length,
      bodies: bodies.mock.calls.length,
      attempts: attempts.mock.calls.length,
      visits: sourceWork.count(),
      queueBodySerializations: queueBodyWork()
    }).toEqual(baseline)
    expect(queuedMessagesPublishedBytes(worker.journal)).toBe(beforeBytes)
    const coordinatorRun = state.db.createRun({
      objective: 'real Run-shaped empty typed peek',
      coordinatorHandle: identity.handle,
      coordinatorPaneKey: identity.paneKey
    })
    const transport = await mailCheckTransport(state.runtime)
    const debtSelections = vi.spyOn(MailDebts.prototype, 'select')
    for (let n = 0; n < 10; n++) {
      expect(
        await harness.call(
          'orchestration.check',
          {
            terminal: identity.handle,
            peek: true,
            types: 'question'
          },
          state.ctx
        )
      ).toMatchObject({ messages: [], count: 0 })
      expect(
        n === 0
          ? await transport.cli(
              new Map<string, string | boolean>([
                ['terminal', identity.handle],
                ['run', coordinatorRun.id],
                ['peek', true],
                ['types', 'question']
              ])
            )
          : await harness.call(
              'orchestration.check',
              {
                terminal: identity.handle,
                run: coordinatorRun.id,
                peek: true,
                types: 'question'
              },
              state.ctx
            )
      ).toMatchObject({ runId: coordinatorRun.id, messages: [], count: 0 })
    }
    expect(attempts).toHaveBeenCalledTimes(count)
    expect(sourceWork.count()).toBe(baseline.visits)
    expect(debtSelections.mock.calls.every(([reason]) => reason === 'check')).toBe(true)
    expect(
      debtSelections.mock.results.every(
        (result) => result.type === 'return' && result.value.length === 0
      )
    ).toBe(true)
    debtSelections.mockRestore()
    // Real old-ID writer, observed by the installed source adapter; U unrelated capacity debt stays parked.
    state.db.routeUnreadDirectMessagesToDispatchMailbox(
      dispatchId,
      moved.run_id,
      'unbound-direct-input'
    )
    await vi.waitFor(() => expect(attempts).toHaveBeenCalledTimes(count + 1))
    expect(attempts.mock.calls.at(-1)?.[1].envelope.clientOperationId).toBe(
      ordinaryMailCreationId(moved)
    )
    expect(sourceWork.count()).toBe(baseline.visits)
    const tail = idOf(
      (
        await harness.call(
          'orchestration.send',
          { from: 'term_coord', to: mailbox, subject: 'new tail' },
          state.ctx
        )
      ).message
    )
    await vi.waitFor(() => expect(attempts).toHaveBeenCalledTimes(count + 2))
    expect(sourceWork.count() - baseline.visits).toBe(1)
    const editing = worker.journal.queuedMessages.get(personal[0]!)!
    const edit = {
      messageId: editing.messageId,
      expectedBodyFingerprint: editing.fingerprint,
      text: 'p'.repeat(100000)
    }
    expect(
      await host.queuedMessageUpdate(
        { callerKey: 'real-client' },
        {
          ...edit,
          envelope: command('agentSession.queuedMessageUpdate', edit)
        }
      )
    ).toMatchObject({ ok: true, value: { status: 'updated' } })
    await vi.waitFor(
      () => expect(state.db.getMessageById(sources[0])?.delivered_at).not.toBeNull(),
      { timeout: 20000 }
    )
    const fields = { messageId: personal[0] }
    expect(
      await host.queuedMessageDelete(
        { callerKey: 'real-client' },
        {
          ...fields,
          envelope: command('agentSession.queuedMessageDelete', fields)
        }
      )
    ).toMatchObject({ ok: true })
    const firstId = ordinaryMailCreationId(state.db.getMessageById(sources[0])!)
    expect(store.readCommandReceipt({ kind: 'global' }, firstId)).toMatchObject({
      verdict: 'readable',
      receipt: { status: 'accepted' }
    })
    expect(dispatch).not.toHaveBeenCalled()
    expect(
      await host.cancel(
        { callerKey: 'real-client' },
        {
          envelope: command('agentSession.cancel', {})
        }
      )
    ).toMatchObject({ ok: true })
    await worker.journal.appendTombstone(turn, { fence: worker.fence })
    const beforeClear = queuedMessagesPublishedBytes(worker.journal)
    const clearing = { command: 'clear' as const }
    expect(
      await host.conversationCommand(
        { callerKey: 'real-client' },
        {
          ...clearing,
          envelope: command('agentSession.conversationCommand', clearing)
        }
      )
    ).toMatchObject({ ok: true })
    expect(queuedMessagesPublishedBytes(worker.journal)).toBeLessThan(beforeClear)
    expect(dispatch).not.toHaveBeenCalled()
    expect(
      await host.queuedMessagesResume(
        { callerKey: 'real-client' },
        {
          envelope: command('agentSession.queuedMessagesResume', {})
        }
      )
    ).toMatchObject({ ok: true })
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1))
    // The ordinary personal cards precede admitted reports; settlement, not token publication, advances them.
    const settle = async () => {
      const submission = worker.journal
        .snapshot()
        .submissions.findLast(
          (row) => row.dispatchState === 'pending' || row.dispatchState === 'accepted'
        )
      if (!submission) {
        throw new Error('Missing active ordinary submission')
      }
      await worker.journal.resolveDispatch({
        clientMessageId: submission.clientMessageId,
        state: 'accepted',
        fence: worker.fence,
        turnScope: AGENT_JOURNAL_THREAD_SCOPE
      })
      await worker.journal.appendItem(
        { provider: 'orca', clientMessageId: `complete-${submission.clientMessageId}` },
        {
          kind: 'turn',
          turnId: submission.clientMessageId,
          state: 'completed',
          userItemId: agentJournalSubmissionKey(submission.clientMessageId)
        },
        { fence: worker.fence, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
      )
    }
    for (let n = 1; n <= 3; n++) {
      await settle()
      await vi.waitFor(() => expect(dispatch.mock.calls.length).toBeGreaterThan(n))
    }
    expect(dispatch.mock.calls[3]?.[0].body.from?.orchestration).toMatchObject({
      messages: [{ messageId: sources[0] }]
    })
    expect(dispatch.mock.calls[3]?.[0].body.blocks).toEqual(
      worker.journal.queuedMessages.get(firstId)?.body.blocks
    )
    const reportTurnCount = dispatch.mock.calls.length
    await worker.append('report-still-running')
    expect(dispatch).toHaveBeenCalledTimes(reportTurnCount)
    await settle()
    await vi.waitFor(() => expect(dispatch.mock.calls.length).toBeGreaterThan(reportTurnCount))
    expect(state.db.getMessageById(tail)?.read).toBe(0)
    console.info(
      'installed semantic source/receipt/body/send/queue work',
      JSON.stringify({
        count,
        baseline,
        beforeBytes,
        afterBytes: queuedMessagesPublishedBytes(worker.journal),
        sourceCalls: sourceWork.calls,
        queueBodySerializations: queueBodyWork(),
        attemptIds: attempts.mock.calls.map(([, input]) => input.envelope.clientOperationId)
      })
    )
    sourceWork.verify()
    sourceWork.restore()
    const retiring = new MessageWaitScope()
    const scoped = state.runtime.waitForMessage(mailbox, { scope: retiring, timeoutMs: 60000 })
    const generic = state.runtime.waitForMessage(mailbox, { timeoutMs: 60000 })
    state.runtime.disposeMessageWaiters()
    expect(await Promise.all([scoped, generic])).toEqual(['cancelled', 'cancelled'])
    expect(state.runtime.messageWaitersByHandle.size).toBe(0)
    expect(retiring.complete()).toBe(true)
    releaseStructuredWorkerSession(dispatchId, state.runtime)
    attempts.mockClear()
    await worker.append('after-retirement')
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(attempts).not.toHaveBeenCalled()
  }
)

it('protects H, actual A and Dispatch through a paged pane-alias check and real Delete room wake, then preserves FIFO replay/ack/finally', async () => {
  vi.useRealTimers()
  const { host, store } = hostTestState()
  const { identity } = await createStructuredWorkerSessionForWorktree({
    runtime: state.runtime,
    worktreeId: 'workspace-1',
    agent: 'codex',
    dispatchId,
    effects: []
  })
  const worker = workerJournal(identity)
  state.db.prepareStartingWorkerAuthority({
    dispatchId,
    handle: identity.handle,
    paneKey: identity.paneKey,
    processIncarnation: identity.processIncarnation,
    worktreeId: 'workspace-1',
    effects: [],
    setupState: 'not_applicable'
  })
  state.db.markWorkerDispatchReady(dispatchId)
  const run = state.db.getDispatchContextById(dispatchId)!.run_id
  const H = 'term_alias'
  const pane = vi.mocked(state.runtime.getTerminalPaneKey).getMockImplementation()
  vi.mocked(state.runtime.getTerminalPaneKey).mockImplementation((handle) =>
    handle === H ? identity.paneKey : (pane?.(handle) ?? null)
  )
  await worker.journal.appendItem(
    { provider: 'orca', clientMessageId: 'active-alias-turn' },
    { kind: 'turn', turnId: 'active-alias-turn', state: 'running' },
    { fence: worker.fence, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
  const cards: string[] = []
  for (let n = 0; n < 4; n++) {
    const body = hostTestMessage('p'.repeat(200000))
    const fields = { body, delivery: 'queue-if-active' as const }
    const id = hostTestOperationId()
    expect(
      await host.send(
        { callerKey: 'real-client' },
        {
          ...fields,
          userSend: true,
          envelope: {
            sessionId: identity.sessionId,
            clientOperationId: id,
            expectedRuntimeFence: worker.fence,
            payloadFingerprint: computeAgentSessionPayloadFingerprint({
              method: 'agentSession.send',
              sessionId: identity.sessionId,
              fields
            })
          }
        }
      )
    ).toMatchObject({ ok: true, value: { queued: {} } })
    cards.push(id)
  }
  const source = state.db.insertMessage({
    runId: run,
    from: 'term_coord',
    to: identity.handle,
    subject: 'actual assignee report'
  })
  state.runtime.deliverPendingMessagesForHandle(identity.handle)
  await new Promise<void>((resolve) => setImmediate(resolve))
  const routed = Array.from({ length: 51 }, (_, n) =>
    state.db.insertMessage({ runId: run, from: 'term_coord', to: H, subject: `H route ${n}` })
  )
  let deleted: Promise<unknown> | undefined
  const scopes: string[][] = []
  const route = state.db.routeUnreadDirectMessagesToDispatchMailbox.bind(state.db)
  vi.spyOn(state.db, 'routeUnreadDirectMessagesToDispatchMailbox').mockImplementation((...args) => {
    const result = route(...args)
    if (args[2] === H && !deleted) {
      scopes.push([...state.runtime.messageWaitersByHandle.keys()])
      const fields = { messageId: cards[0]! }
      deleted = host.queuedMessageDelete(
        { callerKey: 'real-client' },
        {
          ...fields,
          envelope: {
            sessionId: identity.sessionId,
            clientOperationId: hostTestOperationId(),
            expectedRuntimeFence: worker.fence,
            payloadFingerprint: computeAgentSessionPayloadFingerprint({
              method: 'agentSession.queuedMessageDelete',
              sessionId: identity.sessionId,
              fields
            })
          }
        }
      )
    }
    return result
  })
  const transport = await mailCheckTransport(state.runtime)
  const requestId = randomUUID()
  const check = (ack?: string, retry?: string) => {
    const flags = new Map<string, string | boolean>([
      ['terminal', H],
      ['types', 'question']
    ])
    if (ack) {
      flags.set('ack', ack)
    }
    if (retry) {
      flags.set('retry-request', retry)
    }
    return transport.cli(flags)
  }
  const result = await check(undefined, requestId)
  await deleted
  expect(scopes).toEqual([expect.arrayContaining([H, identity.handle, `dispatch:${dispatchId}`])])
  expect(result).toMatchObject({
    count: 50,
    messages: expect.arrayContaining([expect.objectContaining({ id: source.id })])
  })
  const receipt = (value: unknown): string => {
    if (
      value &&
      typeof value === 'object' &&
      'deliveryId' in value &&
      typeof value.deliveryId === 'string'
    ) {
      return value.deliveryId
    }
    throw new Error('missing delivery receipt')
  }
  const first = receipt(result)
  expect(await transport.rpc('orchestration.requestShow', { request: requestId })).toMatchObject({
    ok: true,
    result: { state: 'completed', method: 'orchestration.check' }
  })
  expect(await check(undefined, requestId)).toMatchObject({ deliveryId: first })
  expect(await check()).toMatchObject({ deliveryId: first, replayed: true })
  const tail = await check(first)
  expect(tail).toMatchObject({ count: 2 })
  expect(await check(receipt(tail))).toMatchObject({ count: 0 })
  expect([source, ...routed].every((row) => state.db.getMessageById(row.id)?.read === 1)).toBe(true)
  expect(
    [H, identity.handle, `dispatch:${dispatchId}`].every(
      (key) => !state.runtime.messageWaitersByHandle.has(key)
    )
  ).toBe(true)
  expect(
    store.readCommandReceipt({ kind: 'global' }, ordinaryMailCreationId(source))
  ).toMatchObject({ verdict: 'absent' })
  expect(worker.journal.queuedMessages.get(ordinaryMailCreationId(source))).toBeNull()
  expect(
    await transport.cli(
      new Map<string, string | boolean>([
        ['terminal', H],
        ['peek', true],
        ['types', 'question']
      ])
    )
  ).toMatchObject({ count: 0 })
  const aliases = [H, identity.handle, `dispatch:${dispatchId}`]
  const cancelled = transport.wait({ terminal: H, wait: true, types: 'question', timeoutMs: 10000 })
  await vi.waitFor(() =>
    expect(aliases.every((key) => state.runtime.messageWaitersByHandle.has(key))).toBe(true)
  )
  cancelled.socket.destroy()
  await cancelled.done
  await vi.waitFor(() => expect(transport.active()).toBe(0))
  expect(aliases.every((key) => !state.runtime.messageWaitersByHandle.has(key))).toBe(true)
  const timeout = await transport.check({
    terminal: H,
    wait: true,
    types: 'question',
    timeoutMs: 20
  })
  expect(timeout).toMatchObject({ ok: true, result: { timedOut: true } })
  expect(aliases.every((key) => !state.runtime.messageWaitersByHandle.has(key))).toBe(true)
  const waiting = transport.wait({ terminal: H, wait: true, types: 'question', timeoutMs: 10000 })
  await vi.waitFor(() =>
    expect(aliases.every((key) => state.runtime.messageWaitersByHandle.has(key))).toBe(true)
  )
  // The actual send handler commits and notifies; consuming delivery remains FIFO despite --types.
  expect(
    await transport.rpc('orchestration.send', {
      from: 'term_coord',
      to: H,
      subject: 'legitimate transported wake'
    })
  ).toMatchObject({ ok: true })
  await waiting.done
  const delivered = waiting.frames.find((frame) => frame.ok === true)
  expect(delivered).toMatchObject({
    result: {
      count: 1,
      messages: [expect.objectContaining({ subject: 'legitimate transported wake' })]
    }
  })
  const delivery = receipt(delivered?.result)
  expect(await check()).toMatchObject({ deliveryId: delivery, replayed: true })
  expect(await check(delivery)).toMatchObject({ count: 0 })
  expect(aliases.every((key) => !state.runtime.messageWaitersByHandle.has(key))).toBe(true)
})
