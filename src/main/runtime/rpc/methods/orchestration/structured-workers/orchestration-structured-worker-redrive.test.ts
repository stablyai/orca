import {
  holdClose,
  holdAdmissionReply,
  reattach
} from './orchestration-structured-worker-close.test-fixture'
import { getWorkerTerminalAutoReleaseScheduler } from '../../../../orchestration/terminal-authority/release/worker-terminal-auto-release-scheduler'
import { readTestHostJournal } from '../../../../../native-chat/agent-session-journal/journal-observation.test-support'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../../../../shared/constants'
import { partialRuntimeStore } from '../../../../orca-runtime-tests/runtime-store-partial-fixture'
import { withChatTabChanges } from '../../../../agent-session/agent-session-tab-layout'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../../../../shared/agent-session/journal/agent-session-journal-types'
import '../../../../../native-chat/agent-session-wire/publication/history/agent-session-history-page'
import '../../../../../native-chat/agent-session-wire/publication/subscribers/agent-session-subscriber-frame-fields'
import { hostTestState } from '../../../../../native-chat/agent-session-wire/host/testing/structured-agent-session-host.test-fixture'
import { createTestParams } from '../../../../../native-chat/agent-session-wire/host/testing/structured-agent-session-create.test-fixture'
import { hostTestOperationId } from '../../../../../native-chat/agent-session-wire/host/testing/structured-agent-session-host-test-data.test-fixture'
import { setStructuredAgentSessionHost } from '../../../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import {
  structuredWorkerIdentities,
  type StructuredWorkerIdentity
} from '../../../../orchestration/terminal-authority/structured-sessions/structured-worker-identity'
import { createOrchestrationRpcHarness } from '../rpc-test-harness'
import {
  createStructuredWorkerSession,
  releaseStructuredWorkerSession
} from './orchestration-structured-worker-session'
import { stopStructuredWorker } from './orchestration-structured-worker-lifecycle'
import { OrcaRuntimeRpcServer } from '../../../server/runtime-rpc'
import { ORCHESTRATION_METHODS } from '../orchestration'
import { STATUS_METHODS } from '../../host-management/status'
import { createKeyedTrailingEdgeCoalescer } from '../../../../client/events/keyed-trailing-edge-coalescer'
import { subscribeForRedrive } from '../../../../orchestration/mailbox/structured-pointer/structured-session-journal-redrive'
import { idOf, resultOf } from '../../../orchestration-session-caller-test-fixture'
import { createStructuredWorkerSessionForWorktree } from '../worker/worker-topology'
import { completeWorkerTerminalRelease } from '../worker/worker-release-completion'

vi.mock('../../structured-sessions/creation/structured-agent-session-create', () => ({
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
let watches: (() => void)[]

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
  watches = []
  dispatchId = createDispatch()
})

afterEach(() => {
  watches.forEach((dispose) => dispose())
  for (const id of workerSessionIds) {
    releaseStructuredWorkerSession(id, state.runtime)
  }
  vi.useRealTimers()
  harness.cleanup()
  setStructuredAgentSessionHost(null)
  structuredWorkerIdentities.clear()
  vi.restoreAllMocks()
})

async function startWorker(workerDispatchId = dispatchId) {
  const { identity } = await createStructuredWorkerSession({
    runtime: state.runtime,
    worktreeId: 'workspace-1',
    agent: 'codex',
    dispatchId: workerDispatchId
  })
  workerSessionIds.push(identity.sessionId)
  return workerJournal(identity)
}

/** A worker heard as parked mail hears it: every publication of its journal, coalesced. */
async function startWatchedWorker() {
  const worker = await startWorker()
  const onJournalActivity = vi.fn<(sessionId: string) => void>()
  watches.push(
    subscribeForRedrive(worker.host, worker.identity.sessionId, onJournalActivity, () => true)
  )
  return { ...worker, onJournalActivity }
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

async function automaticCloseFixture() {
  vi.useRealTimers()
  vi.useFakeTimers({ toFake: ['Date'] })
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
  const worker = await startOwnedWorker()
  const { host, identity } = worker
  const { store } = hostTestState()
  const attached = host.collaboratorsForTests().sessions.get(identity.sessionId)
  const lease = store.requireWritableRecord(identity.sessionId).lease
  const tab = host.getSessionTabId(identity.sessionId)
  if (!tab) {
    throw new Error('Worker has no listed tab')
  }
  savedSession =
    withChatTabChanges('local', savedSession, identity.worktreeId, [
      {
        open: { sessionId: identity.sessionId, agent: 'codex', tabId: tab }
      }
    ]) ?? savedSession
  await state.runtime.publishStructuredAgentSessionTab({
    workspaceId: identity.worktreeId,
    sessionId: identity.sessionId,
    agent: 'codex',
    activate: true
  })
  await vi.waitFor(() =>
    expect(host.readStatusSummary(identity.sessionId)).toMatchObject({
      hostExecutionPhase: 'ready'
    })
  )
  const resource = claimAutomaticRelease(identity)
  const stop = vi.fn<NonNullable<typeof host.deps.adapter.closeSession>>(async () => true)
  host.deps.adapter.closeSession = stop
  const close = () =>
    completeWorkerTerminalRelease({
      runtime: state.runtime,
      db: state.db,
      dispatchId,
      resource: state.db.getWorkerTerminalResource(resource.id)!
    })
  const presentation = state.runtime.captureStructuredAgentSessionPresentation(identity.sessionId)
  const savedBefore = structuredClone(savedSession)
  const retained = () => {
    expect(state.runtime.captureStructuredAgentSessionPresentation(identity.sessionId)).toEqual(
      presentation
    )
    expect(savedSession).toEqual(savedBefore)
    expect(host.collaboratorsForTests().sessions.get(identity.sessionId)).toBe(attached)
    expect(store.requireWritableRecord(identity.sessionId).lease).toEqual(lease)
    expect(host.getSessionTabId(identity.sessionId)).toBe(tab)
    expect(stop).not.toHaveBeenCalled()
  }
  return { ...worker, store, resource, close, retained, lease, attached }
}

describe('the structured redrive publication edge', () => {
  it.each(['stream', 'journal'] as const)(
    '%s steers real CLI mail into the running turn, retains failed sends and cancels teardown',
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
      expect((await host.currentWork(worker.identity.sessionId))?.working()).toBe(true)
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
      const cliPath = '../../../../../../cli/index'
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
        // A send that throws keeps its reservation; the session's next journal edge finds it never
        // admitted and sends it again under the same id.
        const send = vi.spyOn(host, 'send').mockRejectedValueOnce(new Error('provider unavailable'))
        const messageId = await sendMail('Continue during the current turn')
        expect(send).toHaveBeenCalledTimes(1)
        expect(state.db.getMessageById(messageId)).toMatchObject({ read: 0 })
        expect(state.db.getStructuredMailSends(mailbox)).toHaveLength(1)
        const mailOperation = state.db.getStructuredMailSends(mailbox)[0]!.operation_id
        await worker.append('provider-available')
        await vi.advanceTimersByTimeAsync(300)
        await vi.waitFor(async () => {
          expect(await host.sendAnswer(worker.identity.sessionId, mailOperation)).toEqual({
            kind: 'accepted'
          })
        })
        expect(state.db.getMessageById(messageId)).toMatchObject({
          read: 0,
          delivered_at: expect.any(String)
        })
        expect(dispatch).toHaveBeenCalledTimes(1)
        expect(dispatch.mock.calls[0]![0].body).toMatchObject({
          kind: 'message',
          role: 'user',
          blocks: [
            {
              type: 'text',
              text: expect.stringContaining('Subject: Continue during the current turn')
            }
          ],
          from: {
            orchestration: {
              message: 'mail-notice',
              mailbox,
              messages: [{ messageId }]
            }
          }
        })
        releaseStructuredWorkerSession(worker.identity.sessionId, state.runtime)
        disposeStream()
        notify.mockClear()
        const cancelledId = await sendMail('Do not deliver after teardown')
        await worker.append('after-teardown')
        await vi.advanceTimersByTimeAsync(5_000)
        expect(notify).not.toHaveBeenCalled()
        expect(dispatch).toHaveBeenCalledTimes(1)
        expect(state.db.getMessageById(cancelledId)).toMatchObject({ read: 0 })
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
      expect(state.db.getMessageById(messageId)).toMatchObject({ read: 0 })
      expect(state.db.getStructuredMailSends(mailbox)).toHaveLength(1)
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
        } else {
          expect(state.db.keepWorkerTerminalOpen(identity.paneKey)).toBe(1)
        }
      } finally {
        await heldClose.release()
      }
      expect(await closing).toMatchObject({ state: 'retained', processAction: 'none' })
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
      // The send that threw keeps its reservation for the retry.
      expect(state.db.getMessageById(messageId)).toMatchObject({ read: 0 })
      expect(state.db.getStructuredMailSends(mailbox)).toHaveLength(1)
      if (mode === 'new-turn') {
        await journal.appendTombstone(newTurn, { fence: lease.runtimeFence })
        await vi.advanceTimersByTimeAsync(300)
        expect(observe).not.toHaveBeenCalled()
        expect(create).not.toHaveBeenCalled()
        // Its Dispatch settled: the mail goes to a follow-up, never into the chat that finished it.
        expect(send).toHaveBeenCalledTimes(1)
        expect(dispatch).not.toHaveBeenCalled()
        await vi.waitFor(() =>
          expect(state.db.getMessageById(messageId)).toMatchObject({ read: 0, delivered_at: null })
        )
      }
    }
  )

  it('retains a committed running turn while its status publication is held', async () => {
    const h = await automaticCloseFixture()
    const lane = holdClose(h.identity.sessionId)
    const closing = h.close()
    await lane.entered
    const published = h.host.readStatusSummary(h.identity.sessionId)
    const seen = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const gate = state.db.admitWorkerChatReleaseClose.bind(state.db)
    vi.spyOn(state.db, 'admitWorkerChatReleaseClose').mockImplementation((...args) => {
      try {
        return gate(...args)
      } finally {
        release.resolve()
      }
    })
    const observer = h.journal.reads.observer
    vi.spyOn(h.journal.reads, 'observer').mockImplementation(async (input) => {
      const answer = await observer(input)
      seen.resolve()
      await release.promise
      return answer
    })
    try {
      await h.journal.appendItem(
        { provider: 'orca', clientMessageId: 'running-before-close' },
        { kind: 'turn', turnId: 'running-before-close', state: 'running' },
        { fence: h.fence, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
      )
      await seen.promise
      expect(h.host.readStatusSummary(h.identity.sessionId)).toEqual(published)
      await lane.release()
      expect(await closing).toMatchObject({ state: 'retained', processAction: 'none' })
      h.retained()
      expect(state.db.getWorkerTerminalResource(h.resource.id)).toMatchObject({
        ownership_state: 'owned',
        release_state: 'not_requested',
        auto_release_at: null
      })
    } finally {
      release.resolve()
      await lane.release()
    }
  })

  it('retains ingress admitted during the held work reply and orders queued writes after the decision', async () => {
    const h = await automaticCloseFixture()
    const held = holdAdmissionReply(h.journal)
    const closing = h.close()
    const order: string[] = []
    const gate = state.db.admitWorkerChatReleaseClose.bind(state.db)
    vi.spyOn(state.db, 'admitWorkerChatReleaseClose').mockImplementation((...args) => {
      const admitted = gate(...args)
      order.push('close decision')
      return admitted
    })
    await held.entered
    const events = hostTestState().acquire.mock.calls.at(-1)?.[0].events
    if (!events) {
      throw new Error('Worker provider has no event sink')
    }
    events.appendItem(
      { provider: 'orca', clientMessageId: 'running-during-read' },
      { kind: 'turn', turnId: 'running-during-read', state: 'running' },
      { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    const queued = h.append('queued-behind-read').then(() => order.push('write committed'))
    held.release()
    expect(await closing).toMatchObject({ state: 'retained', processAction: 'none' })
    await queued
    await h.host.flushStreamedEvents(h.identity.sessionId)
    expect(order).toEqual(['close decision', 'write committed'])
    h.retained()
    expect((await readTestHostJournal(h.host, h.identity.sessionId)).items).toContainEqual(
      expect.objectContaining({
        body: { kind: 'turn', turnId: 'running-during-read', state: 'running' }
      })
    )
  })

  it('lets Keep open during the work reply preserve a real unsent card and every close resource', async () => {
    const h = await automaticCloseFixture()
    const card = await h.journal.queuedMessages.insert({
      messageId: hostTestOperationId(),
      body: {
        kind: 'message',
        role: 'user',
        blocks: [{ type: 'text', text: 'Keep this unsent message' }]
      },
      holdReason: 'send_failed'
    })
    const held = holdAdmissionReply(h.journal)
    const closing = h.close()
    await held.entered
    expect(state.db.keepWorkerTerminalOpen(h.identity.paneKey)).toBe(1)
    held.release()
    expect(await closing).toMatchObject({ state: 'retained', processAction: 'none' })
    h.retained()
    expect(await h.journal.queuedMessages.get(card.messageId)).toEqual(card)
    expect(state.db.getWorkerTerminalResource(h.resource.id)).toMatchObject({
      ownership_state: 'owned',
      release_state: 'retained',
      retained_reason: 'user_kept'
    })
  })

  it('honors explicit release that joins while the automatic work read is held', async () => {
    const h = await automaticCloseFixture()
    const held = holdAdmissionReply(h.journal)
    const closing = h.close()
    await held.entered
    const events = hostTestState().acquire.mock.calls.at(-1)?.[0].events
    if (!events) {
      throw new Error('Worker provider has no event sink')
    }
    events.appendItem(
      { provider: 'orca', clientMessageId: 'explicit-release-turn' },
      { kind: 'turn', turnId: 'explicit-release-turn', state: 'running' },
      { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    state.db.requestWorkerTerminalRelease(dispatchId)
    held.release()
    expect(await closing).toMatchObject({
      state: 'released',
      processAction: 'closed_agent_terminal'
    })
    expect(h.store.requireWritableRecord(h.identity.sessionId).lease.claimStatus).toBe('released')
    expect(h.host.isSessionTabVisible(h.identity.sessionId)).toBe(false)
  })

  it('retries an idle read failure through the existing countdown and then closes normally', async () => {
    const h = await automaticCloseFixture()
    const held = holdAdmissionReply(h.journal)
    const closing = h.close()
    await held.entered
    held.fail()
    expect(await closing).toMatchObject({ state: 'retained', processAction: 'none' })
    h.retained()
    expect(state.db.getWorkerTerminalResource(h.resource.id)).toMatchObject({
      release_state: 'not_requested',
      auto_release_at: expect.any(String)
    })
    vi.setSystemTime(Date.now() + 120_001)
    await getWorkerTerminalAutoReleaseScheduler(state.runtime).releaseDue()
    expect(state.db.getWorkerTerminalResource(h.resource.id)?.release_state).toBe('released')
    expect(h.store.requireWritableRecord(h.identity.sessionId).lease.claimStatus).toBe('released')
    expect(h.host.isSessionTabVisible(h.identity.sessionId)).toBe(false)
  })

  it('lets Keep open cancel the countdown rearmed after an idle read failure', async () => {
    const h = await automaticCloseFixture()
    const held = holdAdmissionReply(h.journal)
    const closing = h.close()
    await held.entered
    held.fail()
    expect(await closing).toMatchObject({ state: 'retained', processAction: 'none' })
    expect(state.db.keepWorkerTerminalOpen(h.identity.paneKey)).toBe(1)
    vi.setSystemTime(Date.now() + 120_001)
    await getWorkerTerminalAutoReleaseScheduler(state.runtime).releaseDue()
    h.retained()
    expect(state.db.getWorkerTerminalResource(h.resource.id)).toMatchObject({
      ownership_state: 'owned',
      release_state: 'retained',
      retained_reason: 'user_kept',
      auto_release_at: null
    })
  })

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

  it('keeps the observer across close and reattach with a new fence', async () => {
    const { host, identity, onJournalActivity } = await startWatchedWorker()
    await reattach(identity.sessionId)
    const snapshot = vi.spyOn(host.collaboratorsForTests().subscribers, 'snapshot')
    await host.close(identity.sessionId, 'evict')
    await readTestHostJournal(host, identity.sessionId)
    vi.advanceTimersByTime(300)
    onJournalActivity.mockClear()

    await reattach(identity.sessionId)
    vi.advanceTimersByTime(300)

    expect(snapshot).toHaveBeenCalled()
    expect(onJournalActivity).toHaveBeenCalledExactlyOnceWith(identity.sessionId)
  })
})
