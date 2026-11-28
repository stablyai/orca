import { afterEach, expect, it, vi } from 'vitest'
import { activeProviderContext } from '../../../../../shared/agent-session/conversation-context/agent-session-provider-context'
import { agentSessionFailureFact } from '../../../../../shared/agent-session/failures/agent-session-failure'
import { agentSessionFailureWords } from '../../../../../shared/agent-session/failures/agent-session-failure-words'
import { testOrcaSessionId } from '../../../../../shared/agent-session/identity/orca-session-address-test-fixture'
import { OPENCODE_ACP_DIALECT } from '../../../../acp/acp-dialects/opencode-dialect'
import { AcpStructuredLane } from '../../../../acp/journal/acp-structured-lane'
import { deferred } from '../../../../acp/process/testing/acp-scripted-agent.test-support'
import { providerTimelineSink } from '../../../../native-chat/agent-session-timeline/provider-timeline-plan'
import { setStructuredAgentSessionHost } from '../../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { recordingStructuredAgentSessionLogger } from '../../../../native-chat/agent-session-wire/host/testing/structured-agent-session-logger.test-fixture'
import {
  HOST_TEST_LOCATION,
  HOST_TEST_NOW as NOW
} from '../../../../native-chat/agent-session-wire/host/testing/structured-agent-session-host-test-data.test-fixture'
import { eventually } from '../../../../native-chat/agent-session-wire/host/testing/structured-agent-session-queued-message-rig-provider.test-fixture'
import {
  createQueuedMessageTestRig,
  type QueuedMessageTestRig
} from '../../../../native-chat/agent-session-wire/host/testing/structured-agent-session-queued-message-rig.test-fixture'
import { projectWorkerFleet } from '../../../rpc/methods/orchestration/worker/fleet/worker-list-projection'
import { OrchestrationDb } from '../../db/orchestration-db'
import {
  mintStructuredWorkerHandle,
  mintStructuredWorkerPaneKey,
  structuredWorkerIdentities,
  structuredWorkerProcessIncarnation
} from '../../terminal-authority/structured-sessions/structured-worker-identity'
import { createSessionWorkerLivenessReader } from '../lifecycle/session-worker-liveness'
import { escalateChatWorkerError } from './chat-worker-error-escalation'
import {
  reportChatWorkerClosedByUser,
  reportChatWorkerProviderDeath
} from './chat-worker-provider-death'
import { observeChatWorkerWorking } from './chat-worker-turn-stops'

const SESSION = testOrcaSessionId('7e3b9d15-2c4a-4f86-a0b1-5c9e2d7f3b64')
const HANDLE = mintStructuredWorkerHandle()
const RUNTIME = 'runtime-under-test'
let db: OrchestrationDb | undefined
let rig: QueuedMessageTestRig | undefined
let lane: AcpStructuredLane | undefined

afterEach(async () => {
  lane?.dispose()
  structuredWorkerIdentities.forget(HANDLE)
  setStructuredAgentSessionHost(null)
  await rig?.dispose()
  db?.close()
  lane = undefined
  rig = undefined
  db = undefined
})

async function startWorker({
  unavailableErrorRead = false,
  autoContinue = { enabled: false }
} = {}) {
  const database = new OrchestrationDb(':memory:')
  db = database
  const run = database.createRun({
    objective: 'collect a report',
    coordinatorHandle: 'term_coordinator',
    coordinatorPaneKey: 'tab_coordinator:11111111-1111-4111-8111-111111111111'
  })
  const task = database.createTask({ spec: 'inspect a file', runId: run.id })
  const { dispatch } = database.createStartingWorkerDispatch({
    creator: { kind: 'system' },
    maxDepth: 10,
    taskId: task.id,
    startOptions: {}
  })
  database.prepareStartingWorkerAuthority({
    dispatchId: dispatch.id,
    handle: HANDLE,
    paneKey: mintStructuredWorkerPaneKey(SESSION),
    processIncarnation: structuredWorkerProcessIncarnation(SESSION),
    hostScope: JSON.stringify({ kind: 'local', hostId: 'local' }),
    worktreeId: HOST_TEST_LOCATION.workspaceId,
    terminalOwnership: 'created',
    effects: [],
    setupState: 'not_applicable'
  })
  database.markWorkerDispatchReady(dispatch.id)

  const deps = { getDb: () => database, notify: () => {}, isWaitingForMail: () => false }
  const reports: Promise<void>[] = []
  const current = await createQueuedMessageTestRig({
    sessionId: SESSION,
    restartable: true,
    hostDeps: {
      usageLimitAutoContinue: {
        isEnabled: () => autoContinue.enabled,
        isWorkspaceAsleep: () => false,
        subscribe: () => () => {}
      },
      onRequestFailure: (failure) => {
        const request = unavailableErrorRead
          ? { ...failure, read: () => Promise.reject(new Error('journal read unavailable')) }
          : failure
        reports.push(escalateChatWorkerError(request, deps))
      },
      onIdleProviderDeath: (death) => reportChatWorkerProviderDeath(death, deps),
      onUserClosedProvider: (closed) => reportChatWorkerClosedByUser(closed, RUNTIME, deps)
    }
  })
  rig = current
  setStructuredAgentSessionHost(current.host)
  await current.store.setSessionTabVisibility(SESSION, true)
  const { sessions, lifetime } = current.host.collaboratorsForTests()
  await eventually(() => expect(sessions.get(SESSION)?.child?.phase).toBe('ready'))
  const journal = sessions.get(SESSION)?.journal
  const child = sessions.get(SESSION)?.child
  const sink = providerTimelineSink(current.providerEvents())
  if (!journal || !child?.generation || !sink) {
    throw new Error('expected the attached provider')
  }

  const timeline = new AcpStructuredLane({
    sink,
    sessionId: SESSION,
    agent: 'codex',
    agentName: 'Worker',
    generation: child.generation,
    providerSessionId: 'fixture-thread',
    dialect: OPENCODE_ACP_DIALECT,
    logger: recordingStructuredAgentSessionLogger().logger,
    onInputAccepted: () => {},
    onFailed: (reason) => {
      throw new Error(reason)
    }
  })
  lane = timeline
  timeline.apply([{ type: 'turn.open', turn: 'work', at: NOW - 100 }])
  await sink.written?.()

  const exit = {
    type: 'ended',
    sessionId: SESSION,
    cause: 'unexpected-exit',
    reason: 'provider process exited',
    failure: agentSessionFailureFact('providerExited', {
      detail: { text: 'fixture process exit code 42', audience: 'log' }
    }),
    fence: child.fence,
    acquisitionGeneration: child.generation,
    observedAt: NOW
  } as const
  const reportExit = () => current.host.handleAdapterEvent(exit)
  const endTimeline = () =>
    timeline.apply([{ type: 'session.ended', verdict: { state: 'interrupted', completedAt: NOW } }])
  const finishAtUsageLimit = async (turn = 'work') => {
    timeline.apply([
      ...(turn === 'work' ? [] : [{ type: 'turn.open' as const, turn, at: NOW }]),
      {
        type: 'item.open',
        item: `usage-limit-${turn}`,
        join: { turn },
        body: {
          kind: 'status',
          ...agentSessionFailureWords(
            agentSessionFailureFact('usageLimitReached', {
              usageLimit: { resetsAt: NOW + 60_000 }
            }),
            { surface: 'row' }
          )
        }
      },
      {
        type: 'turn.end',
        turn,
        state: 'completed',
        outcome: 'failure',
        at: turn === 'work' ? NOW - 1 : NOW + 1
      }
    ])
    await sink.written?.()
  }
  const writePartialReply = () => {
    timeline.apply([
      { type: 'text.delta', item: { id: 'reply' }, channel: 'assistant', text: 'Work in progress' }
    ])
    timeline.flush()
  }
  const record = () => current.store.requireWritableRecord(SESSION)
  const project = () =>
    projectWorkerFleet({
      rows: database.listWorkerTerminalResources({ dispatchIds: [dispatch.id], limit: 1 }),
      attentionFacts: database.getWorkerAttentionFactsForDispatches([dispatch.id], NOW),
      statuses: [],
      observeSession: createSessionWorkerLivenessReader(database, [], undefined, {
        includeResumeGuidance: true
      }),
      limit: 1,
      now: NOW
    }).workers[0]
  const readReports = async () => {
    await new Promise<void>((resolve) => setImmediate(resolve))
    await Promise.all(reports)
    return database
      .getUnreadRunMailbox(run.id, 20, ['escalation'])
      .map(({ payload }) => JSON.parse(payload ?? 'null'))
  }
  const resume = async () => {
    const followUp = current.send('Continue the same task', undefined, {
      fence: record().lease.runtimeFence,
      internal: true
    })
    expect(await followUp.result).toMatchObject({ ok: true })
    await eventually(() => expect(sessions.get(SESSION)?.child?.phase).toBe('ready'))
    const resumed = sessions.get(SESSION)?.child
    if (!resumed?.generation) {
      throw new Error('expected the resumed provider')
    }
    expect(resumed.fence).not.toBe(child.fence)
    return { fence: resumed.fence, acquisitionGeneration: resumed.generation }
  }
  return {
    deps,
    current,
    database,
    task,
    dispatch,
    journal,
    sink,
    record,
    project,
    endTimeline,
    finishAtUsageLimit,
    writePartialReply,
    readReports,
    reportExit,
    resume,
    lifetime,
    exit
  }
}

it('reports the same interrupted request once and offers in-place resume after the adapter settles it first', async () => {
  const worker = await startWorker()
  const linkedThread = activeProviderContext(worker.record()).head?.handle.nativeId
  worker.endTimeline()
  await worker.sink.written?.()
  await worker.reportExit()
  await worker.reportExit()

  expect(await worker.readReports()).toMatchObject([
    {
      turnOutcome: 'interruption',
      dispatchId: worker.dispatch.id,
      failureKind: 'providerExited',
      detail: 'fixture process exit code 42'
    }
  ])
  expect(worker.project()).toMatchObject({
    liveness: { verdict: 'exited' },
    stage: { worker: 'ready', dispatch: 'dispatched', detail: 'input_accepted' },
    attention: { requiresAction: true, categories: ['interruption'] },
    nextAction: {
      kind: 'recover',
      argv: [
        'orchestration',
        'send',
        '--to',
        `dispatch:${worker.dispatch.id}`,
        '--subject',
        'Continue',
        '--body',
        'Continue the interrupted task.'
      ]
    }
  })

  const resumed = await worker.resume()
  expect(worker.database.getDispatchContextById(worker.dispatch.id)?.task_id).toBe(worker.task.id)
  expect(activeProviderContext(worker.record()).head?.handle.nativeId).toBe(linkedThread)
  worker.database.completeDispatch(worker.dispatch.id)
  await worker.current.host.handleAdapterEvent({ ...worker.exit, ...resumed })
  expect(await worker.readReports()).toHaveLength(1)
})

it('keeps inspection guidance when an idle provider exits behind a usage-limit mail hold', async () => {
  const worker = await startWorker()
  await worker.finishAtUsageLimit()
  expect(await worker.journal.queuedMessages.failureHolds()).toBe(true)
  await worker.reportExit()
  expect(worker.project()).toMatchObject({
    liveness: { verdict: 'exited' },
    nextAction: { argv: ['orchestration', 'worker-read', '--dispatch', worker.dispatch.id] }
  })
})

it('wakes on a proven exit when the journal detail read fails and leaves an explicit stop quiet', async () => {
  const worker = await startWorker({ unavailableErrorRead: true })
  const writeStarted = deferred<void>()
  const releaseWrite = deferred<void>()
  const appendSteps = worker.journal.appendSteps.bind(worker.journal)
  const slowWrite = vi
    .spyOn(worker.journal, 'appendSteps')
    .mockImplementationOnce(async (...args) => {
      writeStarted.resolve(undefined)
      await releaseWrite.promise
      return appendSteps(...args)
    })
  try {
    worker.writePartialReply()
    const written = worker.sink.written?.()
    await writeStarted.promise
    const ended = worker.reportExit()
    releaseWrite.resolve(undefined)
    await Promise.all([written, ended])
  } finally {
    releaseWrite.resolve(undefined)
    slowWrite.mockRestore()
  }

  expect(await worker.readReports()).toMatchObject([
    { turnOutcome: 'interruption', dispatchId: worker.dispatch.id }
  ])
  await worker.resume()
  await worker.lifetime.stopAgent(SESSION, { recorded: 'user-stop' })
  expect(worker.project()).toMatchObject({
    liveness: { verdict: 'exited' },
    attention: { requiresAction: false },
    nextAction: { argv: ['orchestration', 'worker-read', '--dispatch', worker.dispatch.id] }
  })
  expect(await worker.readReports()).toHaveLength(1)
})

it('escalates a usage limit once while Orca keeps continuing the worker, and again once it stops', async () => {
  const autoContinue = { enabled: true }
  const worker = await startWorker({ autoContinue })
  const resetsAt = new Date(NOW + 60_000).toISOString()
  await worker.finishAtUsageLimit()
  expect(await worker.readReports()).toMatchObject([
    { failureKind: 'usageLimitReached', resetsAt, continuesAt: resetsAt, orcaContinues: true }
  ])

  // The continued turn meets the same limit while Orca still continues it: no second escalation.
  observeChatWorkerWorking(SESSION, worker.deps)
  await worker.finishAtUsageLimit('continued')
  expect(await worker.readReports()).toHaveLength(1)

  // Orca no longer continues it: the next limit escalates once more, with the reset.
  autoContinue.enabled = false
  observeChatWorkerWorking(SESSION, worker.deps)
  await worker.finishAtUsageLimit('stopped')
  const reports = await worker.readReports()
  expect(reports).toHaveLength(2)
  expect(reports[1]).toMatchObject({ failureKind: 'usageLimitReached', resetsAt })
  expect(reports[1]).not.toHaveProperty('orcaContinues')
})

it('fails the Dispatch and tells the coordinator once when a person closes a running chat worker', async () => {
  const worker = await startWorker()
  await worker.current.host.close(SESSION, 'user-close')
  await worker.current.host.close(SESSION, 'user-close')

  expect(await worker.readReports()).toMatchObject([
    { dispatchId: worker.dispatch.id, handle: HANDLE, stopReason: 'lost' }
  ])
  expect(worker.database.getDispatchContextById(worker.dispatch.id)?.status).toBe('failed')
  expect(worker.database.getWorkerDispatch(worker.dispatch.id)?.state).toBe('failed')
})

/** The provider outlives this stop, which keeps its cause on the still-live child. */
async function leaveStopUnproven(
  worker: Awaited<ReturnType<typeof startWorker>>,
  stop: () => Promise<void>
) {
  worker.current.closeSession.mockResolvedValueOnce(false)
  await expect(stop()).rejects.toThrow()
  expect(worker.current.host.collaboratorsForTests().sessions.get(SESSION)?.child).toBeTruthy()
}

it.each([
  [
    'an Orca eviction',
    (worker: Awaited<ReturnType<typeof startWorker>>) => worker.current.host.close(SESSION, 'evict')
  ],
  [
    'an Orca eviction that joins a workspace sleep stop',
    async (worker: Awaited<ReturnType<typeof startWorker>>) => {
      // Sleep's stop is left unproven, so the eviction joins its 'user-close' on the live provider.
      await leaveStopUnproven(worker, () =>
        worker.lifetime.stopAgent(SESSION, { cause: 'user-close' })
      )
      await worker.current.host.close(SESSION, 'evict')
    }
  ],
  [
    "a person's close that joins an unproven Stop",
    async (worker: Awaited<ReturnType<typeof startWorker>>) => {
      await leaveStopUnproven(worker, () =>
        worker.lifetime.stopAgent(SESSION, { recorded: 'user-stop' })
      )
      await worker.current.host.close(SESSION, 'user-close')
    }
  ],
  [
    "a person's close after workspace sleep already stopped the provider",
    async (worker: Awaited<ReturnType<typeof startWorker>>) => {
      await worker.lifetime.stopAgent(SESSION, { cause: 'user-close' })
      await worker.current.host.close(SESSION, 'user-close')
    }
  ],
  [
    'quitting Orca',
    (worker: Awaited<ReturnType<typeof startWorker>>) =>
      worker.current.host.flushAllStreamedEvents({ trigger: 'quit' })
  ]
])('sends no closed-worker message for %s', async (_, end) => {
  const worker = await startWorker()
  await end(worker)
  expect(await worker.readReports()).toEqual([])
  expect(worker.database.getDispatchContextById(worker.dispatch.id)?.status).toBe('dispatched')
})

it('sends nothing when a person closes a chat worker that already reported worker_done', async () => {
  const worker = await startWorker()
  worker.database.completeDispatch(worker.dispatch.id)
  await worker.current.host.close(SESSION, 'user-close')
  expect(await worker.readReports()).toEqual([])
  expect(worker.database.getDispatchContextById(worker.dispatch.id)?.status).toBe('completed')
})

it('leaves an in-flight worker-stop to settle its own stop when a person closes the chat', async () => {
  const worker = await startWorker()
  worker.database.beginWorkerStop(worker.dispatch.id, RUNTIME)
  await worker.current.host.close(SESSION, 'user-close')
  expect(await worker.readReports()).toEqual([])
  expect(worker.database.getWorkerDispatch(worker.dispatch.id)?.state).toBe('stopping')
})
