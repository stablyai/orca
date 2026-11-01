import './rpc/unused-default-rpc-methods.test-fixture'
// A finished structured worker takes follow-up work in its own chat through worker-start --terminal <handle>, or a send to its Dispatch.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ORCA_SESSION_ADDRESS_PREFIX } from '../../shared/orca-session-address'
import { testOrcaSessionId } from '../../shared/orca-session-address-test-fixture'
import { idOf } from './rpc/orchestration-session-caller-test-fixture'
import {
  COORDINATOR,
  WAIT,
  call,
  connectionFor,
  coordinatorRunAndTask,
  db,
  dispatcher,
  host,
  openChat,
  request,
  runtime,
  sendUserMessage,
  settleTurn,
  turnText
} from './structured-chat-coordinator-mail-rig.test-fixture'
import { structuredWorkerIdentities } from './structured-worker-identity'
import { createStructuredWorkerSession } from './rpc/methods/orchestration-structured-worker-session'
import type { placeWorkerAgent } from './rpc/methods/orchestration/worker/worker-start-agent-placement'

// The worker's chat is created in the rig's real session host, as the production create would.
vi.mock('./rpc/methods/structured-agent-session-create', () => ({
  createStructuredAgentSessionForWorktree: async (args: {
    caller: { callerKey: string }
    envelope: { sessionId: string }
  }) => {
    const rig = await import('./structured-chat-coordinator-mail-rig.test-fixture')
    const { attachParams } = await import('./structured-chat-coordinator-fake-codex-fixture')
    const attached = await rig.host.attach(args.caller, attachParams(args.envelope.sessionId))
    await rig.host.setSessionTabVisibility(args.envelope.sessionId, true)
    rig.threadBySession.set(args.envelope.sessionId, rig.codex.connections.at(-1)!.threadId!)
    return attached
  }
}))

type WorkspaceLookup = {
  showManagedTerminalWorkspace: (
    ...args: Parameters<typeof runtime.showManagedTerminalWorkspace>
  ) => Promise<Awaited<ReturnType<typeof placeWorkerAgent>>['worktree']>
}

const LOCAL = JSON.stringify({ kind: 'local', hostId: 'local' })

beforeEach(() => {
  structuredWorkerIdentities.clear()
  // The rig stubs these for its PTY workers; a structured worker's come from its registered identity.
  vi.mocked(runtime.getTerminalPaneKey).mockImplementation(
    (handle) => structuredWorkerIdentities.get(handle)?.paneKey ?? null
  )
  vi.mocked(runtime.getTerminalProcessIncarnation).mockImplementation(
    (handle) => structuredWorkerIdentities.get(handle)?.processIncarnation ?? null
  )
  vi.spyOn<WorkspaceLookup, 'showManagedTerminalWorkspace'>(
    runtime,
    'showManagedTerminalWorkspace'
  ).mockImplementation(async (selector) => ({
    id: selector.replace(/^id:/, ''),
    repoId: 'repo'
  }))
})

function reportDone(sessionId: string, taskId: string, dispatchId: string) {
  return dispatcher.dispatch(
    request(
      'orchestration.send',
      {
        subject: 'Done',
        type: 'worker_done',
        payload: JSON.stringify({ taskId, dispatchId, outcome: 'succeeded' })
      },
      { sessionId }
    )
  )
}

/** A worker created as worker-start creates one, after its first Dispatch reported done. */
async function finishedStructuredWorker(
  taskId: string,
  settle: 'done' | 'abandon' | 'none' = 'done'
) {
  const disposed = vi.fn()
  const observe = host.observeJournalPublications.bind(host)
  const observed = vi
    .spyOn(host, 'observeJournalPublications')
    .mockImplementation((id, listener) => {
      const dispose = observe(id, listener)
      return () => {
        disposed()
        dispose()
      }
    })
  const started = db.createStartingWorkerDispatch({
    creator: { kind: 'session', orcaSessionId: testOrcaSessionId(COORDINATOR) },
    maxDepth: 9,
    taskId,
    startOptions: { agent: 'codex' }
  })
  const { identity } = await createStructuredWorkerSession({
    runtime,
    worktreeId: host.deps.store.getConversation(COORDINATOR)!.location.workspaceId,
    agent: 'codex',
    dispatchId: started.dispatch.id,
    onJournalActivity: () => {}
  })
  db.prepareStartingWorkerAuthority({
    dispatchId: started.dispatch.id,
    handle: identity.handle,
    paneKey: identity.paneKey,
    processIncarnation: identity.processIncarnation,
    hostScope: LOCAL,
    worktreeId: identity.worktreeId,
    effects: [],
    setupState: 'not_applicable',
    terminalOwnership: 'created'
  })
  db.markWorkerDispatchReady(started.dispatch.id)
  if (settle === 'abandon') {
    await call(
      'orchestration.workerAbandon',
      { dispatch: started.dispatch.id },
      { sessionId: COORDINATOR }
    )
  } else if (settle === 'done') {
    expect(await reportDone(identity.sessionId, taskId, started.dispatch.id)).toMatchObject({
      ok: true,
      result: { lifecycle: { action: 'completed' } }
    })
  }
  return { identity, observed, disposed, firstDispatchId: started.dispatch.id }
}

async function followUpTask(): Promise<string> {
  const task = await call(
    'orchestration.taskCreate',
    { spec: 'and the docs' },
    { sessionId: COORDINATOR }
  )
  return idOf(task.task)
}

describe('a finished structured worker', () => {
  it('takes a follow-up Dispatch in its chat, and releasing it frees the worker', async () => {
    await openChat(COORDINATOR)
    const { taskId } = await coordinatorRunAndTask()
    const { identity, disposed, firstDispatchId } = await finishedStructuredWorker(taskId)
    const worker = connectionFor(identity.sessionId)
    const resource = db.getWorkerTerminalResourceByOwner(firstDispatchId)
    expect(resource?.auto_release_at).not.toBeNull()

    const followUp = await followUpTask()
    const started = call(
      'orchestration.workerStart',
      { task: followUp, terminal: identity.handle },
      { sessionId: COORDINATOR }
    )
    await vi.waitFor(() => expect(worker.turns).toHaveLength(1), WAIT)
    await settleTurn(identity.sessionId, 0)
    const receipt = await started

    expect(receipt).toMatchObject({ state: 'ready', turnStart: 'observed' })
    const dispatchId = String(receipt.dispatchId)
    const task = turnText(worker.turns[0]!)
    expect(task).toContain(dispatchId)
    expect(task).toContain(
      `Your Orca session ID is: ${ORCA_SESSION_ADDRESS_PREFIX}${identity.sessionId}`
    )
    expect(db.getDispatchContextById(dispatchId)).toMatchObject({
      assignee_handle: identity.handle,
      assignee_orca_session_id: identity.sessionId
    })
    expect(db.getWorkerTerminalResourceByOwner(dispatchId)).toMatchObject({
      id: resource!.id,
      ownership_state: 'owned',
      auto_release_at: null
    })

    expect(await reportDone(identity.sessionId, followUp, dispatchId)).toMatchObject({ ok: true })
    expect(disposed).not.toHaveBeenCalled()
    await call('orchestration.workerRelease', { dispatch: dispatchId }, { sessionId: COORDINATOR })
    await vi.waitFor(() => expect(disposed).toHaveBeenCalledTimes(1), WAIT)
  })

  it('given new work after abandon, watches its journal again so parked mail is retried', async () => {
    await openChat(COORDINATOR)
    const { taskId } = await coordinatorRunAndTask()
    const { identity, observed, disposed } = await finishedStructuredWorker(taskId, 'abandon')
    expect(disposed).toHaveBeenCalledTimes(1)
    const worker = connectionFor(identity.sessionId)
    const watches = () => observed.mock.calls.filter(([id]) => id === identity.sessionId).length
    expect(watches()).toBe(1)

    const followUp = await followUpTask()
    const started = call(
      'orchestration.workerStart',
      { task: followUp, terminal: identity.handle },
      { sessionId: COORDINATOR }
    )
    await vi.waitFor(() => expect(worker.turns).toHaveLength(1), WAIT)
    await settleTurn(identity.sessionId, 0)
    const dispatchId = String((await started).dispatchId)
    expect(watches()).toBe(2)

    expect(await reportDone(identity.sessionId, followUp, dispatchId)).toMatchObject({ ok: true })
    await call('orchestration.workerRelease', { dispatch: dispatchId }, { sessionId: COORDINATOR })
    await vi.waitFor(() => expect(disposed).toHaveBeenCalledTimes(2), WAIT)
  })

  it('kept open by the user takes follow-up work and stays kept', async () => {
    await openChat(COORDINATOR)
    const { taskId } = await coordinatorRunAndTask()
    const { identity, firstDispatchId } = await finishedStructuredWorker(taskId)
    const worker = connectionFor(identity.sessionId)
    expect(db.keepWorkerTerminalOpen(identity.paneKey)).toBe(1)

    const followUp = await followUpTask()
    const started = call(
      'orchestration.workerStart',
      { task: followUp, terminal: identity.handle },
      { sessionId: COORDINATOR }
    )
    await vi.waitFor(() => expect(worker.turns).toHaveLength(1), WAIT)
    await settleTurn(identity.sessionId, 0)
    const dispatchId = String((await started).dispatchId)
    expect(await reportDone(identity.sessionId, followUp, dispatchId)).toMatchObject({ ok: true })

    expect(db.getWorkerTerminalResourceByOwner(dispatchId)).toMatchObject({
      prior_owner_dispatch_ids: JSON.stringify([firstDispatchId]),
      release_state: 'retained',
      retained_reason: 'user_kept',
      auto_release_at: null
    })
  })

  it("is not handed a Dispatch that would leave it in the finished one's custody", async () => {
    await openChat(COORDINATOR)
    const { taskId } = await coordinatorRunAndTask()
    const { identity, firstDispatchId } = await finishedStructuredWorker(taskId)
    const worker = connectionFor(identity.sessionId)
    const followUp = await followUpTask()
    const dispatch = () =>
      dispatcher.dispatch(
        request(
          'orchestration.dispatch',
          { task: followUp, to: identity.handle, inject: true },
          { sessionId: COORDINATOR }
        )
      )

    expect(await dispatch()).toMatchObject({
      ok: false,
      error: {
        message: expect.stringContaining(
          `worker-start --task ${followUp} --terminal ${identity.handle}`
        )
      }
    })
    db.keepWorkerTerminalOpen(identity.paneKey)
    expect(await dispatch()).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
    expect(worker.turns).toHaveLength(0)
    expect(db.getWorkerTerminalResourceByOwner(firstDispatchId)).toBeDefined()
  })
})

function sendTo(dispatchId: string, body: string) {
  return call(
    'orchestration.send',
    { to: `dispatch:${dispatchId}`, subject: 'Follow-up', body },
    { sessionId: COORDINATOR }
  )
}

describe('a send to a finished structured worker', () => {
  it('becomes one follow-up on that worker; a racing send steers it', async () => {
    await openChat(COORDINATOR)
    const { taskId } = await coordinatorRunAndTask()
    const { identity, firstDispatchId } = await finishedStructuredWorker(taskId)
    const worker = connectionFor(identity.sessionId)

    const first = sendTo(firstDispatchId, 'and the docs')
    const second = sendTo(firstDispatchId, 'also the changelog')
    await vi.waitFor(() => expect(worker.turns).toHaveLength(1), WAIT)
    await settleTurn(identity.sessionId, 0)
    const [followUp, steered] = await Promise.all([first, second])

    expect(followUp).toMatchObject({
      delivery: 'follow_up',
      followUpOf: firstDispatchId,
      effects: expect.arrayContaining([
        expect.objectContaining({ role: 'agent', id: identity.handle })
      ]),
      state: 'ready'
    })
    expect(turnText(worker.turns[0]!)).toContain('and the docs')
    expect(steered).toMatchObject({
      message: { to_handle: `dispatch:${String(followUp.dispatchId)}` }
    })
    expect(db.getDispatchContextById(String(followUp.dispatchId))).toMatchObject({
      follow_up_of_dispatch_id: firstDispatchId,
      assignee_orca_session_id: identity.sessionId
    })
  })

  it('queued behind the turn the worker reported from is accepted, not unknown', async () => {
    await openChat(COORDINATOR)
    const { taskId } = await coordinatorRunAndTask()
    const { identity, firstDispatchId } = await finishedStructuredWorker(taskId, 'none')
    const worker = connectionFor(identity.sessionId)
    expect(await sendUserMessage(identity.sessionId, 'go')).toMatchObject({ ok: true })
    await vi.waitFor(() => expect(worker.turns).toHaveLength(1), WAIT)
    // The worker reports from inside that turn, which is still running.
    worker.handlers.onNotification?.('turn/started', { turn: { id: 'turn-1' } })
    await host.flushStreamedEvents(identity.sessionId)
    expect(await reportDone(identity.sessionId, taskId, firstDispatchId)).toMatchObject({
      ok: true
    })

    expect(await sendTo(firstDispatchId, 'and the docs')).toMatchObject({
      delivery: 'follow_up',
      state: 'ready',
      turnStart: 'queued'
    })
    worker.handlers.onNotification?.('turn/completed', { turn: { id: 'turn-1' } })
    await host.flushStreamedEvents(identity.sessionId)
    await vi.waitFor(() => expect(worker.turns.length).toBeGreaterThan(1), WAIT)
    expect(worker.turns.map(turnText).join('\n')).toContain('and the docs')
  })

  it('after it was closed, reopens its chat in the same conversation', async () => {
    await openChat(COORDINATOR)
    const { taskId } = await coordinatorRunAndTask()
    const { identity, firstDispatchId } = await finishedStructuredWorker(taskId)
    // The rig has no settings store; reopening validates the worker's agent against it.
    vi.spyOn(runtime, 'validateOrchestrationAgentLauncher').mockImplementation(() => {})
    await call(
      'orchestration.workerRelease',
      { dispatch: firstDispatchId },
      { sessionId: COORDINATOR }
    )
    expect(host.isSessionTabVisible(identity.sessionId)).toBe(false)

    const followUp = sendTo(firstDispatchId, 'and the docs')
    await vi.waitFor(() => expect(connectionFor(identity.sessionId).turns).toHaveLength(1), WAIT)
    await settleTurn(identity.sessionId, 0)

    expect(await followUp).toMatchObject({ delivery: 'reopened', state: 'ready' })
    expect(host.isSessionTabVisible(identity.sessionId)).toBe(true)
    expect(db.getWorkerTerminalResourceByOwner(String((await followUp).dispatchId))).toMatchObject({
      terminal_handle: identity.handle,
      ownership_state: 'owned'
    })
  })

  it('that it never read before reporting becomes its follow-up', async () => {
    await openChat(COORDINATOR)
    const { taskId } = await coordinatorRunAndTask()
    const { identity, firstDispatchId } = await finishedStructuredWorker(taskId, 'none')
    const worker = connectionFor(identity.sessionId)
    await sendTo(firstDispatchId, 'and the docs')
    // The mail pointer arrives; the worker reports without reading it.
    await vi.waitFor(() => expect(worker.turns).toHaveLength(1), WAIT)
    await settleTurn(identity.sessionId, 0)

    expect(await reportDone(identity.sessionId, taskId, firstDispatchId)).toMatchObject({
      ok: true
    })
    await vi.waitFor(() => expect(worker.turns).toHaveLength(2), WAIT)
    await settleTurn(identity.sessionId, 1)

    expect(turnText(worker.turns[1]!)).toContain('and the docs')
    await vi.waitFor(
      () => expect(db.getUnreadMessages(`dispatch:${firstDispatchId}`)).toHaveLength(0),
      WAIT
    )
  })
})

describe('a finished terminal worker', () => {
  it('is not handed a Dispatch while its finished Dispatch still holds the terminal', async () => {
    await openChat(COORDINATOR)
    const { taskId } = await coordinatorRunAndTask()
    const pane = {
      paneKey: 'tab_pty:dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      processIncarnation: 'pty:1'
    }
    const started = db.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: 9,
      taskId,
      startOptions: {}
    })
    db.prepareStartingWorkerAuthority({
      dispatchId: started.dispatch.id,
      handle: 'term_finished',
      ...pane,
      hostScope: LOCAL,
      worktreeId: 'repo::worker',
      effects: [],
      setupState: 'not_applicable',
      terminalOwnership: 'created'
    })
    db.markWorkerDispatchReady(started.dispatch.id)
    db.abandonWorkerDispatch(started.dispatch.id, runtime.getRuntimeId())
    const followUp = await followUpTask()

    expect(() =>
      db.createDispatchContext({
        taskId: followUp,
        assigneeHandle: 'term_finished',
        assigneePaneKey: pane.paneKey,
        processIncarnation: pane.processIncarnation,
        hostScope: LOCAL,
        creator: { kind: 'system' },
        maxDepth: 9
      })
    ).toThrow(`worker-start --task ${followUp} --terminal term_finished`)
  })
})
