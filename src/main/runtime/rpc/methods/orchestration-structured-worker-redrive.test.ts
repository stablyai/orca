import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../../shared/constants'
import { partialRuntimeStore } from '../../runtime-store-partial-fixture'
import { withChatTabChanges } from '../../agent-session/agent-session-tab-layout'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import * as historyPages from '../../../native-chat/agent-session-wire/agent-session-history-page'
import * as subscriberFrames from '../../../native-chat/agent-session-wire/agent-session-subscriber-frame-fields'
import { hostTestState } from '../../../native-chat/agent-session-wire/structured-agent-session-host-test-harness'
import { createTestParams } from '../../../native-chat/agent-session-wire/structured-agent-session-create-test-fixture'
import {
  hostTestAttachParams,
  hostTestOperationId
} from '../../../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import {
  structuredWorkerIdentities,
  type StructuredWorkerIdentity
} from '../../structured-worker-identity'
import { createOrchestrationRpcHarness } from './orchestration/rpc-test-harness'
import {
  createStructuredWorkerSession,
  releaseStructuredWorkerSession
} from './orchestration-structured-worker-session'
import { stopStructuredWorker } from './orchestration-structured-worker-lifecycle'
import { OrcaRuntimeRpcServer } from '../../runtime-rpc'
import { ORCHESTRATION_METHODS } from './orchestration'
import { STATUS_METHODS } from './status'
import { createKeyedTrailingEdgeCoalescer } from '../../keyed-trailing-edge-coalescer'
import { idOf, resultOf } from '../orchestration-session-caller-test-fixture'
import { createStructuredWorkerSessionForWorktree } from './orchestration/worker/worker-topology'
import { completeWorkerTerminalRelease } from './orchestration/worker/worker-release-completion'

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
let workerSessionIds: string[]

function createDispatch() {
  const task = state.db.createTask({ spec: 'redrive test' })
  const id = state.db.createStartingWorkerDispatch({
    creator: { kind: 'system' },
    maxDepth: 10,
    taskId: task.id,
    startOptions: {}
  }).dispatch.id
  return id
}

beforeEach(() => {
  vi.useFakeTimers()
  structuredWorkerIdentities.clear()
  state = harness.setup()
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
  workerSessionIds = []
  dispatchId = createDispatch()
})

afterEach(() => {
  for (const id of workerSessionIds) {
    releaseStructuredWorkerSession(id, state.runtime)
  }
  vi.useRealTimers()
  harness.cleanup()
  setStructuredAgentSessionHost(null)
  structuredWorkerIdentities.clear()
  vi.restoreAllMocks()
})

async function startWorker(
  onJournalActivity = vi.fn<(sessionId: string) => void>(),
  workerDispatchId = dispatchId
) {
  const { identity } = await createStructuredWorkerSession({
    runtime: state.runtime,
    worktreeId: 'workspace-1',
    agent: 'codex',
    dispatchId: workerDispatchId,
    onJournalActivity
  })
  workerSessionIds.push(identity.sessionId)
  return { ...workerJournal(identity), onJournalActivity }
}

function workerJournal(identity: StructuredWorkerIdentity) {
  const { host, store } = hostTestState()
  const session = host.collaboratorsForTests().sessions.get(identity.sessionId)
  if (!session) {
    throw new Error('Worker did not open its journal')
  }
  const append = async (id: string) => {
    await host
      .collaboratorsForTests()
      .sessions.get(identity.sessionId)!
      .journal.appendItem(
        { provider: 'orca', clientMessageId: id },
        { kind: 'status', text: id },
        {
          fence: store.requireWritableRecord(identity.sessionId).lease.runtimeFence,
          turnScope: AGENT_JOURNAL_THREAD_SCOPE
        }
      )
  }
  return {
    host,
    identity,
    journal: session.journal,
    fence: store.requireWritableRecord(identity.sessionId).lease.runtimeFence,
    append
  }
}

async function startOwnedWorker() {
  const { identity } = await createStructuredWorkerSessionForWorktree({
    runtime: state.runtime,
    worktreeId: 'workspace-1',
    agent: 'codex',
    dispatchId,
    effects: []
  })
  workerSessionIds.push(identity.sessionId)
  await reattach(identity.sessionId)
  state.db.prepareStartingWorkerAuthority({
    dispatchId,
    ...identity,
    hostScope: JSON.stringify(identity.hostScope),
    setupState: 'not_applicable',
    terminalOwnership: 'created',
    effects: []
  })
  state.db.markWorkerDispatchReady(dispatchId)
  return workerJournal(identity)
}

function claimAutomaticRelease(identity: StructuredWorkerIdentity) {
  const worker = state.db.getDispatchContextById(dispatchId)
  if (!worker?.task_id) {
    throw new Error('Worker Dispatch is missing')
  }
  expect(
    state.db.settleWorkerReport({
      taskId: worker.task_id,
      dispatchId,
      outcome: 'succeeded',
      result: 'Worker finished'
    }).action
  ).toBe('settled')
  expect(state.db.claimDueWorkerTerminalAutoReleases(Date.now() + 120_000)).toBe(1)
  const resource = state.db.getWorkerTerminalResourceByOwner(dispatchId)
  if (!resource) {
    throw new Error('Worker resource is missing')
  }
  expect(resource.terminal_handle).toBe(identity.handle)
  return resource
}

function holdClose(sessionId: string) {
  const { host } = hostTestState()
  const lane = Promise.withResolvers<void>()
  const entered = Promise.withResolvers<void>()
  const held = host.collaboratorsForTests().serialize(sessionId, () => lane.promise)
  const close = host.close
  vi.spyOn(host, 'close').mockImplementation((...args) => {
    entered.resolve()
    return close(...args)
  })
  return {
    entered: entered.promise,
    release: async () => {
      lane.resolve()
      await held
    }
  }
}

async function reattach(sessionId: string) {
  const { host, store } = hostTestState()
  const result = await host.attach(
    { callerKey: 'redrive-test' },
    hostTestAttachParams(store.requireWritableRecord(sessionId).lease.runtimeFence, {
      envelope: {
        sessionId,
        clientOperationId: hostTestOperationId(),
        expectedRuntimeFence: store.requireWritableRecord(sessionId).lease.runtimeFence,
        payloadFingerprint: '0'.repeat(64)
      }
    })
  )
  expect(result.ok).toBe(true)
}

describe('the structured redrive publication edge', () => {
  it.each(['stream', 'journal'] as const)(
    '%s delivers real CLI mail after settlement, retains failed sends and cancels teardown',
    async (carrier) => {
      vi.useRealTimers()
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
      const { host, root, store, dispatch } = hostTestState()
      const notify = vi.spyOn(state.runtime, 'notifyStructuredSessionJournalActivity')
      let disposeStream = () => {}
      if (carrier === 'stream') {
        vi.spyOn(host, 'observeJournalPublications').mockImplementation(() => () => {})
      }
      const { identity } = await createStructuredWorkerSessionForWorktree({
        runtime: state.runtime,
        worktreeId: 'workspace-1',
        agent: 'codex',
        dispatchId,
        effects: []
      })
      const worker = workerJournal(identity)
      await reattach(worker.identity.sessionId)
      if (carrier === 'stream') {
        // Preserve the previous batch/reset carrier as an outcome oracle for the moved wake.
        const coalescer = createKeyedTrailingEdgeCoalescer(
          (id) => state.runtime.notifyStructuredSessionJournalActivity(id),
          { flushMs: 300, maxWaitMs: 2_000 }
        )
        const unsubscribe = await host.subscribe({
          id: `orchestration:redrive:${worker.identity.sessionId}`,
          sessionId: worker.identity.sessionId,
          emit: (event) => {
            if (event.type === 'batch' || event.type === 'reset') {
              coalescer.schedule(worker.identity.sessionId)
            }
          }
        })
        disposeStream = () => {
          coalescer.dispose()
          unsubscribe()
        }
      }
      state.db.prepareStartingWorkerAuthority({
        dispatchId,
        handle: worker.identity.handle,
        paneKey: worker.identity.paneKey,
        processIncarnation: worker.identity.processIncarnation,
        worktreeId: 'workspace-1',
        effects: [],
        setupState: 'not_applicable'
      })
      state.db.markWorkerDispatchReady(dispatchId)
      const mailbox = `dispatch:${dispatchId}`
      const held = state.db.insertMessage({
        from: 'term_coord',
        to: mailbox,
        subject: 'Already being handled',
        deliveryContract: 'current_delivery'
      })
      expect(
        state.db
          .getOrCreateMailboxDelivery({
            runId: state.activeRunId!,
            mailboxHandle: mailbox,
            consumerGeneration: state.db.getDispatchContextById(dispatchId)!.consumer_generation
          })
          ?.messages.map((message) => message.id)
      ).toEqual([held.id])
      const fence = store.requireWritableRecord(worker.identity.sessionId).lease.runtimeFence
      const turn = { provider: 'orca', clientMessageId: 'busy-turn' } as const
      await worker.journal.appendItem(
        turn,
        { kind: 'turn', turnId: 'busy-turn', state: 'running' },
        { fence, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
      )
      expect(host.currentWork(worker.identity.sessionId)?.working()).toBe(true)
      await vi.advanceTimersByTimeAsync(300)
      dispatch.mockClear()
      notify.mockClear()
      for (const name of ['ORCA_AGENT_SESSION_ID', 'ORCA_ENVIRONMENT', 'ORCA_PAIRING_CODE']) {
        vi.stubEnv(name, '')
      }
      vi.stubEnv('ORCA_USER_DATA_PATH', root)
      vi.stubEnv('ORCA_TERMINAL_HANDLE', 'term_coord')
      const output = vi.spyOn(console, 'log').mockImplementation(() => {})
      const server = new OrcaRuntimeRpcServer({
        runtime: state.runtime,
        userDataPath: root,
        enableWebSocket: false,
        methods: [...STATUS_METHODS, ...ORCHESTRATION_METHODS]
      })
      const exitCode = process.exitCode
      // The CLI has its own typecheck project; load its real entry point at the runtime boundary.
      const cliPath = '../../../../cli/index'
      const { main }: { main(argv: string[], cwd: string): Promise<void> } = await import(cliPath)
      const sendMail = async (subject: string) => {
        output.mockClear()
        process.exitCode = undefined
        await main(
          ['orchestration', 'send', '--to', mailbox, '--subject', subject, '--json', '--full'],
          root
        )
        expect(process.exitCode, JSON.stringify(output.mock.calls)).toBeUndefined()
        const response: unknown = JSON.parse(String(output.mock.calls.at(-1)?.[0]))
        return idOf(resultOf(response).message)
      }
      try {
        await server.start()
        const messageId = await sendMail('Continue after the current turn')
        expect(state.db.getMessageById(messageId)?.delivered_at).toBeNull()
        expect(dispatch).not.toHaveBeenCalled()
        const send = vi.spyOn(host, 'send').mockRejectedValueOnce(new Error('provider unavailable'))
        await worker.journal.appendTombstone(turn, { fence })
        expect(host.currentWork(worker.identity.sessionId)?.working()).toBe(false)
        await vi.advanceTimersByTimeAsync(300)
        expect(notify).toHaveBeenCalledWith(worker.identity.sessionId)
        expect(send).toHaveBeenCalledTimes(1)
        expect(state.db.getMessageById(messageId)).toMatchObject({ read: 0, delivered_at: null })
        expect(dispatch).not.toHaveBeenCalled()
        await worker.append('provider-available')
        await vi.advanceTimersByTimeAsync(300)
        expect(send).toHaveBeenCalledTimes(2)
        expect(dispatch).toHaveBeenCalledTimes(1)
        expect(dispatch.mock.calls[0]![0].body).toMatchObject({
          kind: 'message',
          role: 'user',
          blocks: [{ type: 'text', text: expect.stringContaining('orchestration check') }],
          from: {
            orchestration: {
              message: 'mail-notice',
              mailbox,
              messages: [{ messageId }]
            }
          }
        })
        expect(state.db.getMessageById(messageId)?.delivered_at).not.toBeNull()
        const nextTurn = { provider: 'orca', clientMessageId: 'busy-at-teardown' } as const
        await worker.journal.appendItem(
          nextTurn,
          { kind: 'turn', turnId: 'busy-at-teardown', state: 'running' },
          { fence, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
        )
        expect(host.currentWork(worker.identity.sessionId)?.working()).toBe(true)
        await vi.advanceTimersByTimeAsync(300)
        const cancelledId = await sendMail('Do not deliver after teardown')
        expect(state.db.getMessageById(cancelledId)?.delivered_at).toBeNull()
        await worker.journal.appendTombstone(nextTurn, { fence })
        releaseStructuredWorkerSession(worker.identity.sessionId, state.runtime)
        disposeStream()
        notify.mockClear()
        await worker.append('after-teardown')
        await vi.advanceTimersByTimeAsync(5_000)
        expect(notify).not.toHaveBeenCalled()
        expect(dispatch).toHaveBeenCalledTimes(1)
        expect(state.db.getMessageById(cancelledId)).toMatchObject({ read: 0, delivered_at: null })
      } finally {
        disposeStream()
        await server.stop()
        process.exitCode = exitCode
        vi.unstubAllEnvs()
      }
    }
  )

  it.each(['new-turn', 'kept-released-owner'] as const)(
    'retains ownership, presentation and parked mail on refused automatic close: %s',
    async (mode) => {
      vi.useRealTimers()
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
      harness.cleanup()
      let savedSession = getDefaultWorkspaceSession()
      state = harness.setup(
        true,
        partialRuntimeStore({
          getWorkspaceSession: () => savedSession,
          getWorkspaceSessionHostIds: () => ['local'],
          setWorkspaceSession: (next) => {
            savedSession = next
          }
        })
      )
      vi.spyOn(state.runtime, 'ensureStructuredAgentSessionHost').mockResolvedValue(undefined)
      dispatchId = createDispatch()
      const { host, store, dispatch } = hostTestState()
      const { identity, journal } = await startOwnedWorker()
      const tabId = host.getSessionTabId(identity.sessionId)
      if (!tabId) {
        throw new Error('Worker has no listed tab')
      }
      savedSession =
        withChatTabChanges('local', savedSession, identity.worktreeId, [
          {
            open: { sessionId: identity.sessionId, agent: 'codex', tabId }
          }
        ]) ?? savedSession
      await state.runtime.publishStructuredAgentSessionTab({
        workspaceId: identity.worktreeId,
        sessionId: identity.sessionId,
        agent: 'codex',
        activate: true
      })
      await vi.advanceTimersByTimeAsync(300)
      const mailbox = `dispatch:${dispatchId}`
      const { id: messageId } = state.db.insertMessage({
        from: 'term_coord',
        to: mailbox,
        subject: 'Continue when available'
      })
      const send = vi.spyOn(host, 'send').mockRejectedValueOnce(new Error('provider unavailable'))
      dispatch.mockClear()
      state.runtime.notifyMessageArrived(mailbox, 'message')
      await vi.advanceTimersByTimeAsync(300)
      expect(send).toHaveBeenCalledTimes(1)
      expect(dispatch).not.toHaveBeenCalled()
      expect(state.db.getMessageById(messageId)).toMatchObject({ read: 0, delivered_at: null })
      const attached = host.collaboratorsForTests().sessions.get(identity.sessionId)
      if (mode === 'kept-released-owner') {
        const child = attached?.child
        if (!child?.generation) {
          throw new Error('Worker has no acquired child')
        }
        await host.handleAdapterEvent({
          type: 'ended',
          sessionId: identity.sessionId,
          fence: child.fence,
          acquisitionGeneration: child.generation,
          reason: 'Provider naturally exited',
          cause: 'unexpected-exit'
        })
        expect(store.requireWritableRecord(identity.sessionId).lease).toMatchObject({
          claimStatus: 'released',
          deathEvidence: { kind: 'exit-observed' }
        })
        expect(host.collaboratorsForTests().sessions.get(identity.sessionId)?.journal).toBe(journal)
      }
      const lease = store.requireWritableRecord(identity.sessionId).lease
      const resource = claimAutomaticRelease(identity)
      const presentation = state.runtime.captureStructuredAgentSessionPresentation(
        identity.sessionId
      )
      expect(presentation.raw).toEqual({
        worktreeId: identity.worktreeId,
        tabId: `agent-session:${identity.sessionId}`
      })
      expect(presentation.saved).toContainEqual({ worktreeId: identity.worktreeId, tabId })
      const savedBefore = structuredClone(savedSession)
      const providerStop = vi.fn<NonNullable<typeof host.deps.adapter.closeSession>>(
        async () => true
      )
      host.deps.adapter.closeSession = providerStop
      const forget = vi.spyOn(state.runtime, 'forgetStructuredSessionMail')
      const retire = vi.spyOn(state.runtime, 'retireStructuredAgentSessionTabFromSnapshot')
      const saved = vi.spyOn(state.runtime, 'removeCapturedStructuredSessionSavedTabs')
      const hide = vi.spyOn(host, 'setSessionTabVisibility')
      const admission = vi.spyOn(state.db, 'admitWorkerChatReleaseClose')
      const observe = vi.spyOn(host, 'observeJournalPublications')
      const create = vi.spyOn(host, 'create')
      const heldClose = holdClose(identity.sessionId)
      const closing = completeWorkerTerminalRelease({
        runtime: state.runtime,
        db: state.db,
        dispatchId,
        resource
      })
      const newTurn = { provider: 'orca', clientMessageId: 'new-turn-before-close' } as const
      try {
        await heldClose.entered
        expect(state.db.getWorkerTerminalResource(resource.id)?.release_state).toBe('releasing')
        expect(state.db.getWorkerTerminalArchive(dispatchId)).toBeDefined()
        if (mode === 'new-turn') {
          await journal.appendItem(
            newTurn,
            { kind: 'turn', turnId: 'new-turn-before-close', state: 'running' },
            { fence: lease.runtimeFence, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
          )
          expect(state.runtime.isWorkerAgentInTurn(resource)).toBe(true)
        } else {
          expect(state.db.keepWorkerTerminalOpen(identity.paneKey)).toBe(1)
        }
      } finally {
        await heldClose.release()
      }
      expect(await closing).toMatchObject({ state: 'retained', processAction: 'none' })
      expect(admission).toHaveBeenCalledExactlyOnceWith(resource.id, expect.any(Function))
      expect(admission.mock.results[0]?.value).toBe(false)
      for (const effect of [providerStop, retire, saved, hide]) {
        expect(effect).not.toHaveBeenCalled()
      }
      expect(host.getSessionTabId(identity.sessionId)).toBe(tabId)
      expect(host.collaboratorsForTests().sessions.get(identity.sessionId)).toBe(attached)
      expect(store.requireWritableRecord(identity.sessionId).lease).toEqual(lease)
      expect(state.db.getWorkerTerminalResource(resource.id)).toMatchObject({
        ownership_state: 'owned',
        release_state: mode === 'new-turn' ? 'not_requested' : 'retained',
        ...(mode === 'kept-released-owner' ? { retained_reason: 'user_kept' } : {})
      })
      expect(state.db.getWorkerTerminalArchive(dispatchId)).toBeUndefined()
      expect.soft(forget).not.toHaveBeenCalled()
      expect.soft(structuredWorkerIdentities.get(identity.handle)).toEqual(identity)
      expect(state.runtime.captureStructuredAgentSessionPresentation(identity.sessionId)).toEqual(
        presentation
      )
      expect(savedSession).toEqual(savedBefore)
      expect(state.db.getMessageById(messageId)).toMatchObject({ read: 0, delivered_at: null })
      if (mode === 'new-turn') {
        await journal.appendTombstone(newTurn, { fence: lease.runtimeFence })
        await vi.advanceTimersByTimeAsync(300)
        expect(observe).not.toHaveBeenCalled()
        expect(create).not.toHaveBeenCalled()
        expect(send).toHaveBeenCalledTimes(2)
        expect(dispatch).toHaveBeenCalledTimes(1)
        expect(dispatch.mock.calls[0]![0].body).toMatchObject({
          kind: 'message',
          role: 'user',
          from: { orchestration: { message: 'mail-notice', mailbox, messages: [{ messageId }] } }
        })
        expect(state.db.getMessageById(messageId)?.delivered_at).not.toBeNull()
      }
    }
  )

  it('releases bookkeeping after an admitted genuinely failed provider Stop without retiring its surface', async () => {
    const { host, store } = hostTestState()
    const { identity } = await startWorker()
    await reattach(identity.sessionId)
    const tabId = host.getSessionTabId(identity.sessionId)
    const child = host.collaboratorsForTests().sessions.get(identity.sessionId)?.child
    if (!child?.generation) {
      throw new Error('Worker has no acquired child')
    }
    const providerStop = vi.fn(async () => false)
    host.deps.adapter.closeSession = providerStop
    const admit = vi.fn(() => true)
    const forget = vi.spyOn(state.runtime, 'forgetStructuredSessionMail')
    const hide = vi.spyOn(host, 'setSessionTabVisibility')
    const retire = vi.spyOn(state.runtime, 'retireStructuredAgentSessionTabFromSnapshot')
    try {
      expect(await stopStructuredWorker(identity, state.runtime, admit)).toMatchObject({
        stopped: false,
        closeAttempted: true
      })
      expect(admit).toHaveBeenCalledOnce()
      expect(providerStop).toHaveBeenCalledOnce()
      expect(admit.mock.invocationCallOrder[0]).toBeLessThan(
        providerStop.mock.invocationCallOrder[0]!
      )
      expect(forget).toHaveBeenCalledExactlyOnceWith(identity.sessionId)
      expect(structuredWorkerIdentities.get(identity.handle)).toBeNull()
      expect(store.requireWritableRecord(identity.sessionId).lease.claimStatus).toBe('live')
      expect(host.getSessionTabId(identity.sessionId)).toBe(tabId)
      expect(hide).not.toHaveBeenCalled()
      expect(retire).not.toHaveBeenCalled()
    } finally {
      await host.handleAdapterEvent({
        type: 'ended',
        sessionId: identity.sessionId,
        fence: child.fence,
        acquisitionGeneration: child.generation,
        reason: 'Provider exited after failed Stop',
        cause: 'unexpected-exit'
      })
    }
  })

  it.each([16, 160])('bounds publication work with %i resting workers', async (count) => {
    const { host } = hostTestState()
    const observe = host.observeJournalPublications
    const visits = new Map<string, ReturnType<typeof vi.fn<() => void>>>()
    const registrations = vi
      .spyOn(host, 'observeJournalPublications')
      .mockImplementation((id, listener) => {
        const visited = vi.fn(listener)
        visits.set(id, visited)
        return observe(id, visited)
      })
    const workers: Awaited<ReturnType<typeof startWorker>>[] = []
    for (let index = 0; index < count; index += 1) {
      workers.push(await startWorker(undefined, index === 0 ? dispatchId : createDispatch()))
    }
    expect(registrations).toHaveBeenCalledTimes(count)
    const readCatalog = vi.fn(() => undefined)
    let catalogChanged = () => {}
    host.deps.adapter.atRestCommands = {
      read: readCatalog,
      onChange: (listener) => {
        catalogChanged = listener
        return () => {}
      }
    }
    host['clientDelivery'].watchAtRestCommands(host.deps.adapter)
    const hooks = host.collaboratorsForTests().subscribers['hooks']
    const reads = [
      readCatalog,
      vi.spyOn(host, 'subscribe'),
      vi.spyOn(historyPages, 'readAgentSessionHistory'),
      vi.spyOn(historyPages, 'readAgentSessionHydrationPage'),
      vi.spyOn(subscriberFrames, 'emitSubscriberFrame'),
      vi.spyOn(hooks, 'readCommands'),
      vi.spyOn(hooks, 'readQueuePublication'),
      vi.spyOn(hooks, 'readBackgroundTasks')
    ]
    for (const visited of visits.values()) {
      visited.mockClear()
    }
    await workers[0]!.append('localized')
    expect([...visits.values()].map((visited) => visited.mock.calls.length)).toEqual([
      1,
      ...Array.from({ length: count - 1 }, () => 0)
    ])
    vi.advanceTimersByTime(300)
    for (const [index, worker] of workers.entries()) {
      expect(worker.onJournalActivity).toHaveBeenCalledTimes(index === 0 ? 1 : 0)
      worker.onJournalActivity.mockClear()
      visits.get(worker.identity.sessionId)!.mockClear()
      expect(
        host.collaboratorsForTests().subscribers.subscriberCountForTests(worker.identity.sessionId)
      ).toBe(0)
    }
    for (const worker of workers) {
      for (let batch = 0; batch < 3; batch += 1) {
        await worker.append(`burst-${batch}`)
        catalogChanged()
      }
      expect(worker.onJournalActivity).not.toHaveBeenCalled()
    }
    vi.advanceTimersByTime(300)
    for (const worker of workers) {
      expect(visits.get(worker.identity.sessionId)).toHaveBeenCalledTimes(3)
      expect(worker.onJournalActivity).toHaveBeenCalledExactlyOnceWith(worker.identity.sessionId)
      worker.onJournalActivity.mockClear()
      visits.get(worker.identity.sessionId)!.mockClear()
      await worker.append('pending-at-release')
    }
    for (const worker of workers) {
      releaseStructuredWorkerSession(worker.identity.sessionId, state.runtime)
    }
    for (const worker of workers) {
      visits.get(worker.identity.sessionId)!.mockClear()
      await worker.append('after-release')
    }
    vi.advanceTimersByTime(5_000)
    for (const worker of workers) {
      expect(visits.get(worker.identity.sessionId)).not.toHaveBeenCalled()
      expect(worker.onJournalActivity).not.toHaveBeenCalled()
    }
    for (const read of reads) {
      expect(read).not.toHaveBeenCalled()
    }
  })

  it('coalesces real commits without client frames, history, commands, queue or roster reads', async () => {
    const { host } = hostTestState()
    const readCatalog = vi.fn(() => undefined)
    let catalogChanged = () => {}
    host.deps.adapter.atRestCommands = {
      read: readCatalog,
      onChange: (listener) => {
        catalogChanged = listener
        return () => {}
      }
    }
    host['clientDelivery'].watchAtRestCommands(host.deps.adapter)
    const worker = await startWorker()
    const hooks = host.collaboratorsForTests().subscribers['hooks']
    const reads = [
      vi.spyOn(historyPages, 'readAgentSessionHistory'),
      vi.spyOn(historyPages, 'readAgentSessionHydrationPage'),
      vi.spyOn(subscriberFrames, 'emitSubscriberFrame'),
      vi.spyOn(hooks, 'readCommands'),
      vi.spyOn(hooks, 'readQueuePublication'),
      vi.spyOn(hooks, 'readBackgroundTasks')
    ]

    for (let batch = 0; batch < 25; batch += 1) {
      await worker.append(`batch-${batch}`)
      catalogChanged()
      vi.advanceTimersByTime(10)
    }
    expect(worker.onJournalActivity).not.toHaveBeenCalled()
    vi.advanceTimersByTime(300)
    expect(worker.onJournalActivity).toHaveBeenCalledExactlyOnceWith(worker.identity.sessionId)
    expect(
      host.collaboratorsForTests().subscribers.subscriberCountForTests(worker.identity.sessionId)
    ).toBe(0)
    expect(readCatalog).not.toHaveBeenCalled()
    for (const read of reads) {
      expect(read).not.toHaveBeenCalled()
    }
  })

  it('wakes after a tombstone settles the running turn', async () => {
    const { identity, journal, fence, onJournalActivity } = await startWorker()
    const turn = { provider: 'orca', clientMessageId: 'running-turn' } as const
    await journal.appendItem(
      turn,
      { kind: 'status', text: 'Working', turnLifecycle: { turnId: 'turn-1', state: 'running' } },
      { fence, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    vi.advanceTimersByTime(300)
    onJournalActivity.mockClear()

    await journal.appendTombstone(turn, { fence })
    vi.advanceTimersByTime(300)

    expect(onJournalActivity).toHaveBeenCalledExactlyOnceWith(identity.sessionId)
    expect(journal.snapshot().items).toEqual([])
  })

  it('still re-evaluates a journal that never goes quiet', async () => {
    const { append, onJournalActivity } = await startWorker()
    for (let batch = 0; batch < 60; batch += 1) {
      await append(`batch-${batch}`)
      vi.advanceTimersByTime(100)
    }
    expect(onJournalActivity.mock.calls.length).toBeGreaterThan(0)
    expect(onJournalActivity.mock.calls.length).toBeLessThan(10)
  })

  it('wakes on the journal rollover that resets client cursors', async () => {
    const { identity, journal, fence, onJournalActivity } = await startWorker()
    const before = journal.cursor()

    await journal.rollEpoch('unreconcilable_prefix', fence)
    vi.advanceTimersByTime(300)

    expect(journal.cursor().epoch).not.toBe(before.epoch)
    expect(onJournalActivity).toHaveBeenCalledExactlyOnceWith(identity.sessionId)
  })

  it('keeps the observer across close and reattach with a new fence', async () => {
    const { host, identity, onJournalActivity } = await startWorker()
    await reattach(identity.sessionId)
    const snapshot = vi.spyOn(host.collaboratorsForTests().subscribers, 'snapshot')
    await host.close(identity.sessionId, 'evict')
    await host.journalSnapshot(identity.sessionId)
    vi.advanceTimersByTime(300)
    onJournalActivity.mockClear()

    await reattach(identity.sessionId)
    vi.advanceTimersByTime(300)

    expect(snapshot).toHaveBeenCalled()
    expect(onJournalActivity).toHaveBeenCalledExactlyOnceWith(identity.sessionId)
  })

  it('wakes on row-free generation end without renewing idle activity', async () => {
    const { host, identity, journal, onJournalActivity } = await startWorker()
    const sessions = host.collaboratorsForTests().sessions
    const before = {
      cursor: journal.cursor(),
      activity: sessions.lastActivityAt(identity.sessionId)
    }
    vi.advanceTimersByTime(1_000)

    host.publishWorkChanged(identity.sessionId)
    vi.advanceTimersByTime(300)

    expect(onJournalActivity).toHaveBeenCalledExactlyOnceWith(identity.sessionId)
    expect(journal.cursor()).toEqual(before.cursor)
    expect(sessions.lastActivityAt(identity.sessionId)).toBe(before.activity)
  })

  it.each(['release', 'stop', 'abandon'] as const)(
    '%s disposes the observer and cancels pending wakes',
    async (action) => {
      const { host } = hostTestState()
      const observe = host.observeJournalPublications
      const disposed = vi.fn()
      vi.spyOn(host, 'observeJournalPublications').mockImplementation((id, listener) => {
        const dispose = observe(id, listener)
        return () => {
          disposed()
          dispose()
        }
      })
      const { identity, append, onJournalActivity } = await startWorker()
      await append('before-release')

      if (action === 'release') {
        releaseStructuredWorkerSession(identity.sessionId, state.runtime)
      } else if (action === 'stop') {
        await stopStructuredWorker(identity, state.runtime)
      } else {
        // Abandon finds the worker by the authority its start recorded.
        state.db.prepareStartingWorkerAuthority({
          dispatchId,
          handle: identity.handle,
          paneKey: identity.paneKey,
          processIncarnation: identity.processIncarnation,
          worktreeId: identity.worktreeId,
          effects: [],
          setupState: 'not_applicable'
        })
        await harness.call('orchestration.workerAbandon', { dispatch: dispatchId }, state.ctx)
      }

      expect(disposed).toHaveBeenCalledTimes(1)
      // A publication after teardown must not re-arm the disposed coalescer.
      if (action === 'stop') {
        await reattach(identity.sessionId)
      }
      await append('after-release')
      vi.advanceTimersByTime(5_000)
      expect(onJournalActivity).not.toHaveBeenCalled()
    }
  )
})
