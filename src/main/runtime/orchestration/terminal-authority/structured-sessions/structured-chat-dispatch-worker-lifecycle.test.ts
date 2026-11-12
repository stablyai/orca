import '../../../rpc/dispatch/testing/unused-default-rpc-methods.test-fixture'

import { describe, expect, it, vi } from 'vitest'
import { formatOrcaSessionAddress } from '../../../../../shared/orca-session-address'
import { testOrcaSessionId } from '../../../../../shared/orca-session-address-test-fixture'
import { idOf } from '../../../rpc/orchestration/callers/session.test-fixture'
import { closeStructuredAgentSessionChild } from '../../../agent-session/structured-agent-session-close'
import type { FakeConnection } from './structured-chat-coordinator-fake-codex-fixture'
import {
  COORDINATOR,
  PEER_CHAT,
  WAIT,
  call,
  clearChat,
  coordinatorRunAndTask,
  db,
  dispatcher,
  host,
  openChat,
  request,
  startClearedContext
} from './structured-chat-coordinator-mail-rig.test-fixture'

const WORKER = formatOrcaSessionAddress(testOrcaSessionId(PEER_CHAT))

/** A Dispatch of the coordinator's task to the peer chat, both chats open. */
async function dispatchToChat(): Promise<{
  taskId: string
  dispatchId: string
  worker: FakeConnection
}> {
  await openChat(COORDINATOR)
  const worker = await openChat(PEER_CHAT)
  const { taskId } = await coordinatorRunAndTask()
  const { dispatch } = await call(
    'orchestration.dispatch',
    { task: taskId, to: WORKER },
    { sessionId: COORDINATOR }
  )
  return { taskId, dispatchId: idOf(dispatch), worker }
}

function workerDone(taskId: string, dispatchId: string) {
  return {
    subject: 'Done',
    type: 'worker_done',
    payload: JSON.stringify({ taskId, dispatchId, outcome: 'succeeded' })
  }
}

/** The chat is still open: its conversation attached and its tab listed. */
function expectChatOpen(sessionId: string): void {
  expect(host.hasSession(sessionId)).toBe(true)
  expect(host.deps.store.getVisibleSessionTabIndex().sessionIds).toContain(sessionId)
}

describe("a chat assignee's report", () => {
  it('is admitted from the same cleared chat, which keeps its Dispatch', async () => {
    const { taskId, dispatchId } = await dispatchToChat()
    const cleared = await clearChat(PEER_CHAT)
    expect(cleared).toBe(PEER_CHAT)
    expect(db.getDispatchContextById(dispatchId)?.status).toBe('dispatched')
    await startClearedContext(cleared)

    await call('orchestration.send', workerDone(taskId, dispatchId), { sessionId: cleared })

    expect(db.getDispatchContextById(dispatchId)?.status).toBe('completed')
  })

  it('is refused from a terminal that names the chat as its caller', async () => {
    const { taskId, dispatchId } = await dispatchToChat()

    const response = await dispatcher.dispatch(
      request('orchestration.send', { ...workerDone(taskId, dispatchId), from: WORKER })
    )

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'session_caller_chat_not_declarable' }
    })
    expect(db.getDispatchContextById(dispatchId)?.status).toBe('dispatched')
  })

  it("is refused from a terminal that carries the chat's Dispatch under its own handle", async () => {
    const { taskId, dispatchId } = await dispatchToChat()

    const receipt = await call('orchestration.send', {
      ...workerDone(taskId, dispatchId),
      from: 'term_worker'
    })

    expect(receipt).toMatchObject({ lifecycle: { action: 'rejected' } })
    expect(db.getDispatchContextById(dispatchId)?.status).toBe('dispatched')
    expect(db.getTask(taskId)?.status).toBe('dispatched')
  })
})

describe("a chat assignee's liveness, stop and close", () => {
  it('reads live at rest, since the next send starts its agent', async () => {
    const { dispatchId } = await dispatchToChat()
    await host.close(PEER_CHAT, 'evict')
    expect(host.deps.store.getRecord(PEER_CHAT)?.lease.claimStatus).toBe('released')

    const shown = await call('orchestration.workerShow', { dispatch: dispatchId })

    expect(shown).toMatchObject({
      observation: { status: 'live', exactWorker: true },
      projection: { liveness: { verdict: 'live', source: 'execution_host' } }
    })
  })

  it('fails its Dispatch when the chat is closed, as a closed terminal does, and reads exited', async () => {
    const { taskId, dispatchId } = await dispatchToChat()

    // As the close RPC does when the person closes the chat's tab.
    await host.setSessionTabVisibility(PEER_CHAT, false)

    expect(db.getDispatchContextById(dispatchId)).toMatchObject({
      status: 'failed',
      termination_reason: 'operator_close'
    })
    expect(db.getTask(taskId)?.status).not.toBe('dispatched')
    expect(await call('orchestration.workerShow', { dispatch: dispatchId })).toMatchObject({
      observation: { status: 'exited' }
    })
  })

  it('keeps its Dispatch while a close remains unproven, and fails it once a close is proven', async () => {
    const { dispatchId } = await dispatchToChat()
    vi.spyOn(host, 'close').mockRejectedValueOnce(new Error('the agent would not stop'))

    // As a refusable worktree removal closes each chat in it.
    const outcome = await closeStructuredAgentSessionChild(PEER_CHAT)

    expect(outcome).toMatchObject({ stopped: false, closeAttempted: true })
    expectChatOpen(PEER_CHAT)
    expect(db.getDispatchContextById(dispatchId)?.status).toBe('dispatched')

    expect(await closeStructuredAgentSessionChild(PEER_CHAT)).toMatchObject({ stopped: true })
    expect(db.getDispatchContextById(dispatchId)).toMatchObject({
      status: 'failed',
      termination_reason: 'operator_close'
    })
  })

  it("keeps its Dispatch when another chat's close lands while its own close remains unproven", async () => {
    const { dispatchId } = await dispatchToChat()
    let refuseClose: (error: Error) => void = () => undefined
    const close = vi
      .spyOn(host, 'close')
      .mockImplementationOnce(() => new Promise((_resolve, reject) => (refuseClose = reject)))
    const closing = closeStructuredAgentSessionChild(PEER_CHAT)
    await vi.waitFor(() => expect(close).toHaveBeenCalled(), WAIT)

    // Its tab stays visible pending the close when the other chat's notice re-derives.
    await host.setSessionTabVisibility(COORDINATOR, false)
    expect(db.getDispatchContextById(dispatchId)?.status).toBe('dispatched')
    refuseClose(new Error('the agent would not stop'))

    expect(await closing).toMatchObject({ stopped: false, closeAttempted: true })
    expectChatOpen(PEER_CHAT)
    expect(db.getDispatchContextById(dispatchId)?.status).toBe('dispatched')
  })
})
