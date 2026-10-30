import './rpc/unused-default-rpc-methods.test-fixture'
// A finished structured worker takes follow-up work in its own chat through worker-start --terminal <handle>.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { formatOrcaSessionAddress } from '../../shared/orca-session-address'
import { testOrcaSessionId } from '../../shared/orca-session-address-test-fixture'
import { idOf } from './rpc/orchestration-session-caller-test-fixture'
import {
  COORDINATOR,
  PEER_CHAT,
  WAIT,
  call,
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
import {
  mintStructuredWorkerHandle,
  mintStructuredWorkerPaneKey,
  structuredWorkerIdentities,
  structuredWorkerProcessIncarnation
} from './structured-worker-identity'
import type { placeWorkerAgent } from './rpc/methods/orchestration/worker/worker-start-agent-placement'

type WorkspaceLookup = {
  showManagedTerminalWorkspace: (
    ...args: Parameters<typeof runtime.showManagedTerminalWorkspace>
  ) => Promise<Awaited<ReturnType<typeof placeWorkerAgent>>['worktree']>
}

const LOCAL = { kind: 'local', hostId: 'local' } as const

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

/** The worker orchestration made of PEER_CHAT, after its first Dispatch reported done. */
async function finishedStructuredWorker(taskId: string) {
  const handle = mintStructuredWorkerHandle()
  const identity = structuredWorkerIdentities.register({
    handle,
    sessionId: PEER_CHAT,
    agent: 'codex',
    paneKey: mintStructuredWorkerPaneKey(PEER_CHAT),
    processIncarnation: structuredWorkerProcessIncarnation(PEER_CHAT),
    worktreeId: host.deps.store.getConversation(PEER_CHAT)!.location.workspaceId,
    hostScope: LOCAL
  })
  const started = db.createStartingWorkerDispatch({
    creator: { kind: 'session', orcaSessionId: testOrcaSessionId(COORDINATOR) },
    maxDepth: 9,
    taskId,
    startOptions: {}
  })
  db.prepareStartingWorkerAuthority({
    dispatchId: started.dispatch.id,
    handle,
    paneKey: identity.paneKey,
    processIncarnation: identity.processIncarnation,
    hostScope: JSON.stringify(LOCAL),
    worktreeId: identity.worktreeId,
    effects: [],
    setupState: 'not_applicable',
    terminalOwnership: 'created'
  })
  db.markWorkerDispatchReady(started.dispatch.id)
  const done = await dispatcher.dispatch(
    request(
      'orchestration.send',
      {
        subject: 'Done',
        type: 'worker_done',
        payload: JSON.stringify({ taskId, dispatchId: started.dispatch.id, outcome: 'succeeded' })
      },
      { sessionId: PEER_CHAT }
    )
  )
  expect(done).toMatchObject({ ok: true, result: { lifecycle: { action: 'completed' } } })
  return { handle, paneKey: identity.paneKey, firstDispatchId: started.dispatch.id }
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
  it('takes a follow-up Dispatch in its chat, and the pending auto-release is cancelled', async () => {
    await openChat(COORDINATOR)
    const worker = await openChat(PEER_CHAT)
    const { taskId } = await coordinatorRunAndTask()
    const { handle, firstDispatchId } = await finishedStructuredWorker(taskId)
    const resource = db.getWorkerTerminalResourceByOwner(firstDispatchId)
    expect(resource?.auto_release_at).not.toBeNull()
    const sent = await dispatcher.dispatch(
      request(
        'orchestration.send',
        { to: `dispatch:${firstDispatchId}`, subject: 'more', body: 'and the docs' },
        { sessionId: COORDINATOR }
      )
    )
    expect(sent).toMatchObject({
      ok: false,
      error: {
        code: 'dispatch_inactive',
        message: expect.stringContaining(`worker-start --task <task_id> --terminal ${handle}`)
      }
    })

    const started = call(
      'orchestration.workerStart',
      { task: await followUpTask(), terminal: handle },
      { sessionId: COORDINATOR }
    )
    await vi.waitFor(() => expect(worker.turns).toHaveLength(1), WAIT)
    await settleTurn(PEER_CHAT, 0)
    const receipt = await started

    expect(receipt).toMatchObject({ state: 'ready', turnStart: 'observed' })
    const dispatchId = String(receipt.dispatchId)
    const task = turnText(worker.turns[0]!)
    expect(task).toContain(dispatchId)
    expect(task).toContain(
      `Your Orca session ID is: ${formatOrcaSessionAddress(testOrcaSessionId(PEER_CHAT))}`
    )
    expect(db.getDispatchContextById(dispatchId)).toMatchObject({
      assignee_handle: handle,
      assignee_orca_session_id: PEER_CHAT
    })
    expect(db.getWorkerTerminalResourceByOwner(dispatchId)).toMatchObject({
      id: resource!.id,
      ownership_state: 'owned',
      auto_release_at: null
    })
  })

  it('kept open by the user is refused, as a kept terminal is', async () => {
    await openChat(COORDINATOR)
    const worker = await openChat(PEER_CHAT)
    const { taskId } = await coordinatorRunAndTask()
    const { handle, paneKey, firstDispatchId } = await finishedStructuredWorker(taskId)
    expect(db.keepWorkerTerminalOpen(paneKey)).toBe(1)

    const receipt = await call(
      'orchestration.workerStart',
      { task: await followUpTask(), terminal: handle },
      { sessionId: COORDINATOR }
    )

    expect(receipt).toMatchObject({
      state: 'failed',
      lastError: expect.stringContaining('was kept open by the user')
    })
    expect(worker.turns).toHaveLength(0)
    expect(db.getWorkerTerminalResourceByOwner(firstDispatchId)?.terminal_handle).toBe(handle)
  })
})
