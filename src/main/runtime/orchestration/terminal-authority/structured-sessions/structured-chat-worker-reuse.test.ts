import { queuedCardTexts } from './structured-chat-coordinator-journal.test-fixture'
import { readTestHostJournal } from '../../../../native-chat/agent-session-journal/journal-observation.test-support'
// A finished structured worker takes follow-up work in its own chat through worker-start --terminal <handle>, or a send to its Dispatch.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import '../../../../../shared/orca-session-address'
import { testOrcaSessionId } from '../../../../../shared/orca-session-address-test-fixture'
import { idOf } from '../../../rpc/orchestration/callers/session.test-fixture'
import {
  COORDINATOR,
  WAIT,
  call,
  connectionFor,
  coordinatorRunAndTask,
  db,
  dispatcher,
  host,
  isWholeMail,
  openChat,
  request,
  runtime,
  sendUserMessage,
  settleTurn,
  turnText
} from './structured-chat-coordinator-mail-rig.test-fixture'
import { getFollowUpDispatch } from '../../db/dispatch-context/worker-follow-up-lineage'
import { structuredWorkerIdentities } from './structured-worker-identity'
import { createStructuredWorkerSession } from '../../../rpc/methods/orchestration/structured-workers/orchestration-structured-worker-session'
import type { placeWorkerAgent } from '../../../rpc/methods/orchestration/worker/worker-start-agent-placement'

// The worker's chat is created in the rig's real session host, as the production create would.
vi.mock(
  '../../../rpc/methods/structured-sessions/creation/structured-agent-session-create',
  () => ({
    createStructuredAgentSessionForWorktree: async (args: {
      caller: { callerKey: string }
      envelope: { sessionId: string }
    }) => {
      const rig = await import('./structured-chat-coordinator-mail-rig.test-fixture')
      const { attachParams } = await import('./structured-chat-coordinator-fake-codex-fixture')
      const attached = await rig.host.attach(
        args.caller,
        attachParams(args.envelope.sessionId, rig.root)
      )
      await rig.host.setSessionTabVisibility(args.envelope.sessionId, true)
      rig.threadBySession.set(args.envelope.sessionId, rig.codex.connections.at(-1)!.threadId!)
      return attached
    }
  })
)

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
  // Each release of the worker's binding frees its handle.
  const forget = vi.spyOn(structuredWorkerIdentities, 'forget')
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
    dispatchId: started.dispatch.id
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
  const released = () => forget.mock.calls.filter(([handle]) => handle === identity.handle).length
  return { identity, released, firstDispatchId: started.dispatch.id }
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
    // The coordinator's chat shows the reopen, never a newly started worker.
    await vi.waitFor(async () => {
      const cards = (await readTestHostJournal(host, COORDINATOR)).items.flatMap(({ body }) =>
        body?.kind === 'agent-start' ? [body] : []
      )
      expect(cards).toEqual([
        expect.objectContaining({ followUp: { of: firstDispatchId, reopened: true } })
      ])
    }, WAIT)
    expect(db.getWorkerTerminalResourceByOwner(String((await followUp).dispatchId))).toMatchObject({
      terminal_handle: identity.handle,
      ownership_state: 'owned'
    })
  })

  it('that it never read before reporting becomes its follow-up', async () => {
    // At cap 1 the brief has no sub-dispatch section, whose helper-mail line names `check`.
    vi.spyOn(runtime, 'getNestedWorkerMaxDepth').mockReturnValue(1)
    await openChat(COORDINATOR)
    const { taskId } = await coordinatorRunAndTask()
    const { identity, firstDispatchId } = await finishedStructuredWorker(taskId, 'none')
    const worker = connectionFor(identity.sessionId)
    const reply = Promise.withResolvers<void>()
    const request = worker.request
    worker.request = async (...args) => {
      const response = await request(...args)
      if (args[0] === 'turn/start') {
        await reply.promise
      }
      return response
    }
    try {
      expect(await sendUserMessage(identity.sessionId, 'go')).toMatchObject({ ok: true })
      await vi.waitFor(() => expect(worker.turns).toHaveLength(1), WAIT)
      worker.handlers.onNotification?.('turn/started', { turn: { id: 'turn-1' } })
      await host.flushStreamedEvents(identity.sessionId)
      await sendTo(firstDispatchId, 'and the docs')
      // The mail waits as a card behind the running turn; the worker reports before it is handed over.
      await vi.waitFor(
        async () => expect(await queuedCardTexts(identity.sessionId)).toHaveLength(1),
        WAIT
      )
      expect(worker.steers).toEqual([])

      expect(await reportDone(identity.sessionId, taskId, firstDispatchId)).toMatchObject({
        ok: true
      })
      // The follow-up took the mail: the old card is gone, its Task waits first, then the mail itself.
      await vi.waitFor(async () => {
        const cards = await queuedCardTexts(identity.sessionId)
        expect(cards).toHaveLength(2)
        expect(cards[0]).toContain('arrive next, one at a time')
        expect(isWholeMail(cards[1]!)).toBe(true)
        expect(cards[1]).toContain('and the docs')
      }, WAIT)
      expect((await queuedCardTexts(identity.sessionId)).join('\n')).not.toContain('`check`')
      reply.resolve()
      worker.handlers.onNotification?.('turn/completed', { turn: { id: 'turn-1' } })
      await host.flushStreamedEvents(identity.sessionId)
      await vi.waitFor(() => expect(worker.turns).toHaveLength(2), WAIT)
      expect(turnText(worker.turns[1]!)).toContain('arrive next, one at a time')
      await settleTurn(identity.sessionId, 1)
      await vi.waitFor(() => expect(worker.turns).toHaveLength(3), WAIT)
      expect(isWholeMail(turnText(worker.turns[2]!))).toBe(true)
      expect(turnText(worker.turns[2]!)).toContain('and the docs')
      await settleTurn(identity.sessionId, 2)

      const followUp = getFollowUpDispatch(db, firstDispatchId)!
      await vi.waitFor(
        () => expect(db.getUnreadMessages(`dispatch:${followUp.id}`)).toEqual([]),
        WAIT
      )
      expect(db.getUnreadMessages(`dispatch:${firstDispatchId}`)).toEqual([])
    } finally {
      reply.resolve()
    }
  })
})
