import './rpc/unused-default-rpc-methods.test-fixture'
// A finished structured worker takes follow-up work in its own chat only through worker-start --terminal <handle>.

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
async function finishedStructuredWorker(taskId: string, settle: 'done' | 'abandon' = 'done') {
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
    startOptions: {}
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
  } else {
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

  it('kept open by the user is refused, as a kept terminal is', async () => {
    await openChat(COORDINATOR)
    const { taskId } = await coordinatorRunAndTask()
    const { identity, firstDispatchId } = await finishedStructuredWorker(taskId)
    const worker = connectionFor(identity.sessionId)
    expect(db.keepWorkerTerminalOpen(identity.paneKey)).toBe(1)

    const receipt = await call(
      'orchestration.workerStart',
      { task: await followUpTask(), terminal: identity.handle },
      { sessionId: COORDINATOR }
    )

    expect(receipt).toMatchObject({
      state: 'failed',
      lastError: expect.stringContaining('was kept open by the user')
    })
    expect(worker.turns).toHaveLength(0)
    expect(db.getWorkerTerminalResourceByOwner(firstDispatchId)?.terminal_handle).toBe(
      identity.handle
    )
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
    expect(await dispatch()).toMatchObject({ ok: false, error: { code: 'terminal_kept_open' } })
    expect(worker.turns).toHaveLength(0)
    expect(db.getWorkerTerminalResourceByOwner(firstDispatchId)).toBeDefined()
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
