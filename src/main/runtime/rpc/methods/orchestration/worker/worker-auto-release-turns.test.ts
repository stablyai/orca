import {
  holdClose,
  holdAdmissionReply,
  reattach
} from '../structured-workers/orchestration-structured-worker-close.test-fixture'
import { readTestHostJournal } from '../../../../../native-chat/agent-session-journal/journal-observation.test-support'
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
import { releaseStructuredWorkerSession } from '../structured-workers/orchestration-structured-worker-session'
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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getWorkerTerminalAutoReleaseScheduler } from '../../../../orchestration/terminal-authority/release/worker-terminal-auto-release-scheduler'
import { WorkerAutoReleaseActivity } from '../../../../orchestration/terminal-authority/release/worker-auto-release-activity'
import type { AgentPhase } from '../../../../../../shared/agent-status/lifecycle/agent-transitions'
import { createOrchestrationWorkerReleaseHarness } from './worker-release.test-support'

const GRACE_MS = 2 * 60_000

describe('orchestration worker automatic release across turns and settings', () => {
  const h = createOrchestrationWorkerReleaseHarness()

  afterEach(() => {
    getWorkerTerminalAutoReleaseScheduler(h.runtime).clear()
    h.cleanup()
    vi.useRealTimers()
  })

  function setupWithFakeClock(): void {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    vi.setSystemTime(new Date('2026-10-27T12:00:00Z'))
    h.setup()
  }

  function moved(from: AgentPhase, to: AgentPhase) {
    return {
      kind: 'moved' as const,
      paneKey: h.workerPaneKey,
      workspace: { worktreeId: 'wt', sshHostId: null },
      from,
      to,
      at: Date.now(),
      transition: null
    }
  }

  async function expectClosedAfterFreshGrace(): Promise<void> {
    await vi.advanceTimersByTimeAsync(GRACE_MS - 1_000)
    expect(h.runtime.closeTerminal).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.waitFor(() => expect(h.runtime.closeTerminal).toHaveBeenCalledTimes(1))
  }

  it('runs no timer while auto-close is off and closes a due worker once it is back on', async () => {
    setupWithFakeClock()
    const { dispatchId } = await h.startSettledWorker()
    const scheduler = getWorkerTerminalAutoReleaseScheduler(h.runtime)
    const claims = vi.spyOn(h.db, 'claimDueWorkerTerminalAutoReleases')

    h.db.workerAutoReleaseEnabled = () => false
    scheduler.rearm()
    await vi.advanceTimersByTimeAsync(2 * GRACE_MS)

    expect(claims).not.toHaveBeenCalled()
    expect(h.runtime.closeTerminal).not.toHaveBeenCalled()
    h.db.workerAutoReleaseEnabled = () => true
    scheduler.rearm()
    await vi.advanceTimersByTimeAsync(0)
    await vi.waitFor(() =>
      expect(h.db.getWorkerTerminalResourceByOwner(dispatchId)?.release_state).toBe('released')
    )
  })

  it('suspends instead of claiming an agent in a turn at its deadline, so nothing is archived', async () => {
    setupWithFakeClock()
    const { dispatchId } = await h.startSettledWorker()
    const inTurn = vi.spyOn(h.runtime, 'isWorkerAgentInTurn').mockReturnValue(true)
    vi.mocked(h.runtime.readTerminal).mockClear()

    await vi.advanceTimersByTimeAsync(GRACE_MS)

    expect(h.runtime.readTerminal).not.toHaveBeenCalled()
    expect(h.db.getWorkerTerminalResourceByOwner(dispatchId)).toMatchObject({
      release_state: 'not_requested',
      auto_release_at: null
    })
    inTurn.mockReturnValue(false)
    new WorkerAutoReleaseActivity(() => h.db).observePane(moved('working', 'done'))
    await expectClosedAfterFreshGrace()
  })

  it('holds the countdown while a follow-up waits on the user', async () => {
    setupWithFakeClock()
    const activity = new WorkerAutoReleaseActivity(() => h.db)
    await h.startSettledWorker()

    activity.observePane(moved('done', 'working'))
    activity.observePane(moved('working', 'needs-you'))
    await vi.advanceTimersByTimeAsync(2 * GRACE_MS)
    expect(h.runtime.closeTerminal).not.toHaveBeenCalled()

    activity.observePane(moved('needs-you', 'done'))
    await expectClosedAfterFreshGrace()
  })

  it('refuses to stop a kept worker without touching it, and stops it once auto-close is allowed', async () => {
    setupWithFakeClock()
    const { dispatchId } = await h.startWorker()
    const keepOpen = (keep: boolean) =>
      h.call('orchestration.workerKeepOpen', { paneKey: h.workerPaneKey, keep })
    await keepOpen(true)

    await expect(
      h.call('orchestration.workerStop', { dispatch: dispatchId })
    ).rejects.toMatchObject({ code: 'terminal_kept_open' })
    expect(h.db.getWorkerDispatch(dispatchId)?.state).toBe('ready')
    expect(h.db.getDispatchContextById(dispatchId)?.capability_revoked_at).toBeNull()

    await keepOpen(false)
    await expect(
      h.call('orchestration.workerStop', { dispatch: dispatchId })
    ).resolves.toMatchObject({ state: 'stopped' })
  })
})

describe('SQLite chat work at automatic release', () => {
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
})
