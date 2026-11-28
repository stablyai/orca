import { afterEach, expect, it, vi } from 'vitest'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../../../shared/agent-session/capabilities/agent-session-runtime-capabilities'
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
  reportChatWorkerClosedByPerson,
  reportChatWorkerProviderDeath
} from './chat-worker-provider-death'
import { STRUCTURED_AGENT_SESSION_CLOSE_METHOD } from '../../../rpc/methods/structured-sessions/conversation/structured-agent-session-close-method'
import type { RpcContext } from '../../../rpc/core'
import { closeMobileStructuredSessionPresentation } from '../../../session-tabs/chat/structured-session-tab-presentation'
import {
  noteStructuredAgentSessionClose,
  refusingStructuredAgentSessionCreatesClosedFirst,
  resetStructuredAgentSessionClosesBeforeCreateForTests
} from '../../../rpc/methods/structured-sessions/creation/structured-agent-session-close-before-create'
import { releaseStoppedStructuredWorker } from '../../../rpc/methods/orchestration/worker/stop/structured-worker-dispatch-stop'
import { formatOrcaSessionAddress } from '../../../../../shared/agent-session/identity/orca-session-address'
import { observeChatWorkerWorking } from './chat-worker-turn-stops'

const SESSION = testOrcaSessionId('7e3b9d15-2c4a-4f86-a0b1-5c9e2d7f3b64')
const HANDLE = mintStructuredWorkerHandle()
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

function startWorkerDispatch(database: OrchestrationDb, taskId: string, keptOpen: boolean) {
  const { dispatch } = database.createStartingWorkerDispatch({
    creator: { kind: 'system' },
    maxDepth: 10,
    taskId,
    startOptions: {}
  })
  const paneKey = mintStructuredWorkerPaneKey(SESSION)
  database.prepareStartingWorkerAuthority({
    dispatchId: dispatch.id,
    handle: HANDLE,
    paneKey,
    processIncarnation: structuredWorkerProcessIncarnation(SESSION),
    hostScope: JSON.stringify({ kind: 'local', hostId: 'local' }),
    worktreeId: HOST_TEST_LOCATION.workspaceId,
    terminalOwnership: 'created',
    effects: [],
    setupState: 'not_applicable'
  })
  database.markWorkerDispatchReady(dispatch.id)
  if (keptOpen) {
    database.keepWorkerTerminalOpen(paneKey)
  }
  return dispatch
}

async function startWorker({
  unavailableErrorRead = false,
  autoContinue = { enabled: false },
  assignee = 'worker',
  keptOpen = false
}: {
  unavailableErrorRead?: boolean
  autoContinue?: { enabled: boolean }
  /** `chat`: the chat is assigned the task directly, with no worker row. */
  assignee?: 'worker' | 'chat'
  keptOpen?: boolean
} = {}) {
  const database = new OrchestrationDb(':memory:')
  db = database
  const run = database.createRun({
    objective: 'collect a report',
    coordinatorHandle: 'term_coordinator',
    coordinatorPaneKey: 'tab_coordinator:11111111-1111-4111-8111-111111111111'
  })
  const task = database.createTask({ spec: 'inspect a file', runId: run.id })
  const dispatch =
    assignee === 'chat'
      ? database.createDispatchContext({
          taskId: task.id,
          assigneeHandle: formatOrcaSessionAddress(SESSION),
          creator: { kind: 'system' },
          maxDepth: 10
        })
      : startWorkerDispatch(database, task.id, keptOpen)
  const forgottenMail: string[] = []
  const workerRuntime = {
    forgetStructuredSessionMail: (sessionId: string) => forgottenMail.push(sessionId),
    notifyMessageArrived: () => {}
  }

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
      onPersonClosedProvider: (closed) =>
        reportChatWorkerClosedByPerson(
          closed,
          {
            runtimeEpoch: 'test-runtime',
            releaseFor: (dispatchId) =>
              releaseStoppedStructuredWorker(workerRuntime, database, dispatchId)
          },
          deps
        )
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
    run,
    forgottenMail,
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

// The close handler reads only these runtime members and the caller identity.
function phoneClose(deviceId: string): RpcContext {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the close handler reads only these runtime members, the caller and its client kind.
  return {
    runtime: {
      bots: { list: () => [] },
      currentLocalStructuredSessionPresentation: () => null,
      captureStructuredAgentSessionPresentation: () => ({ raw: null, saved: [] }),
      retireStructuredAgentSessionTabFromSnapshot: () => false,
      removeCapturedStructuredSessionSavedTabs: () => {}
    },
    caller: { kind: 'paired-device', deviceId },
    clientKind: 'mobile',
    clientCapabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY]
  } as unknown as RpcContext
}

it('stops a working chat worker a person closes from a phone and tells its coordinator who closed it', async () => {
  const worker = await startWorker()
  const exits = vi.spyOn(console, 'info')
  await STRUCTURED_AGENT_SESSION_CLOSE_METHOD.handler({ sessionId: SESSION }, phoneClose('phone-7'))

  expect(worker.database.getWorkerDispatch(worker.dispatch.id)?.state).toBe('stopped')
  expect(worker.database.getDispatchContextById(worker.dispatch.id)?.status).toBe('failed')
  const mail = worker.database.getUnreadRunMailbox(worker.run.id, 20, ['escalation'])
  expect(mail).toHaveLength(1)
  expect(mail[0]).toMatchObject({ subject: 'Worker was closed before it finished' })
  expect(mail[0]?.body).toContain(
    'was closed by a person on a paired phone phone-7 before it finished'
  )
  expect(mail[0]?.body).toContain('closed as stopped')
  expect(exits).toHaveBeenCalledWith(
    expect.stringContaining('provider-exit'),
    expect.objectContaining({
      closeCause: 'user-close',
      closeReason: 'a person on a paired phone phone-7'
    })
  )
  exits.mockRestore()
  // As worker-stop does, its session's parked mail is let go.
  expect(worker.forgottenMail).toContain(SESSION)
})

it('stops a chat worker its user kept open once that person closes it', async () => {
  const worker = await startWorker({ keptOpen: true })
  await STRUCTURED_AGENT_SESSION_CLOSE_METHOD.handler({ sessionId: SESSION }, phoneClose('phone-7'))

  expect(worker.database.getWorkerDispatch(worker.dispatch.id)?.state).toBe('stopped')
  const mail = worker.database.getUnreadRunMailbox(worker.run.id, 20, ['escalation'])
  expect(mail).toHaveLength(1)
  expect(mail[0]?.body).toContain('closed as stopped')
})

it('reports a chat assigned the task directly as stopped once a person closes it', async () => {
  const worker = await startWorker({ assignee: 'chat' })
  await STRUCTURED_AGENT_SESSION_CLOSE_METHOD.handler({ sessionId: SESSION }, phoneClose('phone-7'))

  expect(worker.database.getDispatchContextById(worker.dispatch.id)?.status).toBe('failed')
  const mail = worker.database.getUnreadRunMailbox(worker.run.id, 20, ['escalation'])
  expect(mail).toHaveLength(1)
  expect(mail[0]?.body).toContain('closed as stopped')
  expect(mail[0]?.body).not.toContain('Stop the worker')
})

it('names who closed a chat while its create was still under way', async () => {
  const worker = await startWorker()
  const exits = vi.spyOn(console, 'info')
  // The create comes from the desktop; a phone closes the chat before the create answers.
  const create = refusingStructuredAgentSessionCreatesClosedFirst(async () => {
    noteStructuredAgentSessionClose(SESSION, 'a person on a paired phone phone-9', true)
    return { ok: true }
  })
  const creator = { ...phoneClose('phone-9'), caller: { kind: 'desktop' as const } }
  await create({ envelope: { sessionId: SESSION } }, creator)

  expect(worker.database.getWorkerDispatch(worker.dispatch.id)?.state).toBe('stopped')
  expect(exits).toHaveBeenCalledWith(
    expect.stringContaining('provider-exit'),
    expect.objectContaining({ closeReason: 'a person on a paired phone phone-9' })
  )
  exits.mockRestore()
  resetStructuredAgentSessionClosesBeforeCreateForTests()
})

const CHAT_TAB = {
  type: 'agent-session',
  id: `agent-session:${SESSION}`,
  title: 'Worker',
  sessionId: SESSION,
  agent: 'codex',
  isActive: true
} as const

/** Closes the chat's tab as a client's session.tabs.close does; the window records each stage it
 *  is asked for, with whether the chat's agent still ran at that moment. */
async function closeChatTab(
  worker: Awaited<ReturnType<typeof startWorker>>,
  failHostClose = false
) {
  const { sessions } = worker.current.host.collaboratorsForTests()
  const asked: string[] = []
  const window = {
    closeSessionTab: async (_tabId: string, _worktreeId: string, stage?: { stage: string }) => {
      asked.push(`${stage?.stage ?? 'close'}:${sessions.get(SESSION)?.child ? 'running' : 'ended'}`)
      if (failHostClose && stage?.stage === 'confirm') {
        // The host went away between the window's answer and the host close.
        setStructuredAgentSessionHost(null)
      }
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the same runtime members the close handler reads; a chat close reads no others.
  const runtime = phoneClose('phone-7').runtime as unknown as Parameters<
    typeof closeMobileStructuredSessionPresentation
  >[0]['runtime']
  const closed = await closeMobileStructuredSessionPresentation({
    tab: CHAT_TAB,
    worktreeId: HOST_TEST_LOCATION.workspaceId,
    reason: 'user',
    closedBy: 'a person in the desktop app',
    local: () => true,
    rows: () => undefined,
    notifier: window,
    runtime
  })
  return { asked, closed }
}

it('lets a chat tab leave the window only once its host close landed', async () => {
  const worker = await startWorker()
  expect(await closeChatTab(worker)).toEqual({
    asked: ['confirm:running', 'drop:ended'],
    closed: true
  })
})

it('keeps a chat tab in the window when its host close fails', async () => {
  const worker = await startWorker()
  expect(await closeChatTab(worker, true)).toEqual({
    asked: ['confirm:running', 'failed:running'],
    closed: false
  })
  expect(worker.database.getWorkerDispatch(worker.dispatch.id)?.state).toBe('ready')
})
