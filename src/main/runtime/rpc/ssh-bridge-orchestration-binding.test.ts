import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { OrchestrationDb } from '../orchestration/db'
import type { OrcaRuntimeService } from '../orca-runtime'
import type { RpcResponse } from './core'
import { RpcDispatcher } from './dispatcher'
import { createOrchestrationRpcHarness } from './methods/orchestration/rpc-test-harness'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../../shared/protocol-version'
import { HOST_BOUND_SSH_BRIDGE_SCOPE as HOST_BOUND } from '../../ssh/ssh-bridge-caller-scope.test-fixture'

const SentMessageResult = z.object({ message: z.object({ id: z.string() }) })
const WORKER_PANE = 'tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const SIBLING_PANE = 'tab_sibling:cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const LOCAL_PANE = 'tab_local:dddddddd-dddd-4ddd-8ddd-dddddddddddd'

// A worker on the relay-route SSH host, a sibling on another host, and a local coordinator.
const HOSTS: Record<string, string> = {
  term_worker: 'ssh:box-1',
  term_box_peer: 'ssh:box-1',
  term_coord: 'local',
  term_local: 'local',
  term_sibling: 'ssh:box-2'
}

describe('SSH bridge orchestration without the per-host opt-in', () => {
  const harness = createOrchestrationRpcHarness()
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService

  afterEach(() => harness.cleanup())

  function setup(): void {
    ;({ db, runtime } = harness.setup())
    const panes: Record<string, string> = {
      term_coord: harness.coordinatorPaneKey,
      term_worker: WORKER_PANE,
      term_sibling: SIBLING_PANE,
      term_local: LOCAL_PANE
    }
    vi.mocked(runtime.getTerminalPaneKey).mockImplementation((handle) => panes[handle] ?? null)
    vi.spyOn(runtime, 'getTerminalHandleForPaneKey').mockImplementation(
      (paneKey) => Object.keys(panes).find((handle) => panes[handle] === paneKey) ?? null
    )
    vi.spyOn(runtime, 'showTerminal').mockImplementation(async (handle) => {
      const host = HOSTS[handle]
      if (!host) {
        throw new Error('terminal_not_found')
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the binding reads only executionHostId.
      return { handle, executionHostId: host } as Awaited<
        ReturnType<OrcaRuntimeService['showTerminal']>
      >
    })
    vi.spyOn(runtime, 'notifyMessageArrived').mockImplementation(() => {})
    vi.spyOn(runtime, 'waitForMessage').mockResolvedValue('timed_out')
  }

  function dispatchFromCoordinator(name: string, paneKey: string) {
    const task = db.createTask({ spec: `${name} work` })
    const started = db.createStartingWorkerDispatch({
      creator: { kind: 'terminal', handle: 'term_coord', paneKey: harness.coordinatorPaneKey },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskId: task.id,
      startOptions: {}
    })
    db.prepareStartingWorkerAuthority({
      dispatchId: started.dispatch.id,
      handle: `term_${name}`,
      paneKey,
      processIncarnation: `runtime_test:term_${name}:1`,
      worktreeId: `repo::${name}`,
      effects: [],
      setupState: 'not_applicable',
      terminalOwnership: 'created'
    })
    db.markWorkerDispatchReady(started.dispatch.id)
    return { taskId: task.id, dispatchId: started.dispatch.id }
  }

  function callAsBridge(method: string, params: Record<string, unknown>): Promise<RpcResponse> {
    return new RpcDispatcher({ runtime }).dispatch(
      {
        id: `req-${method}`,
        authToken: 'unused',
        method,
        params,
        orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION
      },
      { callerScope: HOST_BOUND }
    )
  }

  function forbidden(response: RpcResponse): boolean {
    return !response.ok && response.error.code === 'forbidden'
  }

  it('lets a worker on the host report worker_done to the local coordinator that dispatched it', async () => {
    setup()
    const worker = dispatchFromCoordinator('worker', WORKER_PANE)
    const response = await callAsBridge('orchestration.send', {
      from: 'term_worker',
      senderPaneKey: WORKER_PANE,
      subject: 'Done',
      type: 'worker_done',
      payload: JSON.stringify({ ...worker, outcome: 'succeeded' })
    })
    expect(response).toMatchObject({ ok: true, result: { lifecycle: { action: 'completed' } } })
    expect(db.getTask(worker.taskId)?.status).toBe('completed')
  })

  it('lets that worker check its own mailbox and message its coordinator by handle', async () => {
    setup()
    dispatchFromCoordinator('worker', WORKER_PANE)
    expect((await callAsBridge('orchestration.check', { terminal: 'term_worker' })).ok).toBe(true)
    expect((await callAsBridge('orchestration.inbox', { terminal: 'term_worker' })).ok).toBe(true)
    const status = await callAsBridge('orchestration.send', {
      from: 'term_worker',
      to: 'term_coord',
      subject: 'progress',
      type: 'status'
    })
    expect(forbidden(status)).toBe(false)
  })

  it.each<[string, string, Record<string, unknown>]>([
    ['a sender on another host', 'orchestration.send', { from: 'term_sibling', subject: 'x' }],
    ['a sender with no handle', 'orchestration.send', { subject: 'x' }],
    [
      "a sibling's pane key",
      'orchestration.send',
      { from: 'term_worker', senderPaneKey: SIBLING_PANE, subject: 'x' }
    ],
    [
      'a local terminal that is not its coordinator',
      'orchestration.send',
      {
        from: 'term_worker',
        to: 'term_local',
        subject: 'x'
      }
    ],
    ['a group address', 'orchestration.send', { from: 'term_worker', to: '@all', subject: 'x' }],
    ["another host's mailbox", 'orchestration.check', { terminal: 'term_sibling' }],
    ['an unscoped inbox', 'orchestration.inbox', {}],
    [
      "a local terminal's question",
      'orchestration.ask',
      {
        from: 'term_local',
        question: 'Proceed?'
      }
    ]
  ])('refuses %s', async (_case, method, params) => {
    setup()
    dispatchFromCoordinator('worker', WORKER_PANE)
    expect(forbidden(await callAsBridge(method, params))).toBe(true)
  })

  it("refuses a report that names another worker's Dispatch", async () => {
    setup()
    dispatchFromCoordinator('worker', WORKER_PANE)
    const sibling = dispatchFromCoordinator('sibling', SIBLING_PANE)
    const response = await callAsBridge('orchestration.send', {
      from: 'term_worker',
      subject: 'Done',
      type: 'worker_done',
      payload: JSON.stringify({ ...sibling, outcome: 'succeeded' })
    })
    expect(forbidden(response)).toBe(true)
    expect(db.getTask(sibling.taskId)?.status).toBe('dispatched')
  })

  it('refuses a run the caller is no party to', async () => {
    setup()
    dispatchFromCoordinator('worker', WORKER_PANE)
    const other = db.createRun({
      objective: 'Other',
      coordinatorHandle: 'term_local',
      coordinatorPaneKey: LOCAL_PANE
    })
    const response = await callAsBridge('orchestration.check', {
      terminal: 'term_box_peer',
      run: other.id
    })
    expect(forbidden(response)).toBe(true)
  })

  function callAsOwner(method: string, params: Record<string, unknown>): Promise<RpcResponse> {
    return new RpcDispatcher({ runtime }).dispatch({
      id: `owner-${method}`,
      authToken: 'unused',
      method,
      params,
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION
    })
  }

  function placeCoordinatorOnHost(): void {
    vi.mocked(runtime.showTerminal).mockImplementation(async (handle) => {
      const host = handle === 'term_coord' ? 'ssh:box-1' : HOSTS[handle]
      if (!host) {
        throw new Error('terminal_not_found')
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the binding reads only executionHostId.
      return { handle, executionHostId: host } as Awaited<
        ReturnType<OrcaRuntimeService['showTerminal']>
      >
    })
  }

  it("lets a worker reply to coordinator mail routed to its own Dispatch's mailbox", async () => {
    setup()
    const worker = dispatchFromCoordinator('worker', WORKER_PANE)
    const sent = await callAsOwner('orchestration.send', {
      from: 'term_coord',
      to: 'term_worker',
      subject: 'Please confirm',
      body: 'Continue?',
      type: 'status'
    })
    expect(sent).toMatchObject({
      ok: true,
      result: { message: { to_handle: `dispatch:${worker.dispatchId}` } }
    })
    const { message } = SentMessageResult.parse(sent.ok ? sent.result : null)
    const reply = await callAsBridge('orchestration.reply', {
      from: 'term_worker',
      id: message.id,
      body: 'Confirmed'
    })
    expect(reply.ok).toBe(true)
  })

  it('lets an SSH coordinator answer a worker question stored in its own Run mailbox', async () => {
    setup()
    placeCoordinatorOnHost()
    const worker = dispatchFromCoordinator('worker', WORKER_PANE)
    const runId = db.getDispatchContextById(worker.dispatchId)?.run_id ?? ''
    const { message, question } = db.createQuestion({
      runId,
      dispatchId: worker.dispatchId,
      askerHandle: 'term_worker',
      question: 'May I continue?',
      options: []
    })
    expect(message.to_handle).toBe(`run:${runId}`)
    const reply = await callAsBridge('orchestration.reply', {
      from: 'term_coord',
      id: message.id,
      body: 'Proceed'
    })
    expect(reply.ok).toBe(true)
    expect(db.getQuestion(question.message_id)?.status).toBe('answered')
  })

  it("lets a worker address its own Run's mailbox and its own Dispatch explicitly", async () => {
    setup()
    const worker = dispatchFromCoordinator('worker', WORKER_PANE)
    const runId = db.getDispatchContextById(worker.dispatchId)?.run_id ?? ''
    for (const to of [`run:${runId}`, `dispatch:${worker.dispatchId}`]) {
      const sent = await callAsBridge('orchestration.send', {
        from: 'term_worker',
        to,
        subject: 'p'
      })
      expect(forbidden(sent)).toBe(false)
    }
    const asked = await callAsBridge('orchestration.ask', {
      from: 'term_worker',
      to: `run:${runId}`,
      question: 'Proceed?',
      timeoutMs: 1
    })
    expect(forbidden(asked)).toBe(false)
  })

  it('refuses a reply to mail addressed to another terminal, Dispatch, or Run', async () => {
    setup()
    dispatchFromCoordinator('worker', WORKER_PANE)
    const sibling = dispatchFromCoordinator('sibling', SIBLING_PANE)
    const other = db.createRun({
      objective: 'Other',
      coordinatorHandle: 'term_local',
      coordinatorPaneKey: LOCAL_PANE
    })
    for (const to of ['term_local', `dispatch:${sibling.dispatchId}`, `run:${other.id}`]) {
      const original = db.insertMessage({ from: 'term_coord', to, subject: 's', body: 's' })
      const reply = await callAsBridge('orchestration.reply', {
        from: 'term_worker',
        id: original.id,
        body: 'forged'
      })
      expect(forbidden(reply)).toBe(true)
      expect(db.getMessageById(original.id)?.read).toBe(0)
    }
  })

  it("refuses a worker reply to its Run's question, which only the coordinator owns", async () => {
    setup()
    const worker = dispatchFromCoordinator('worker', WORKER_PANE)
    const runId = db.getDispatchContextById(worker.dispatchId)?.run_id ?? ''
    const { message } = db.createQuestion({
      runId,
      dispatchId: worker.dispatchId,
      askerHandle: 'term_worker',
      question: 'May I continue?',
      options: []
    })
    const reply = await callAsBridge('orchestration.reply', {
      from: 'term_worker',
      id: message.id,
      body: 'Proceed'
    })
    expect(forbidden(reply)).toBe(true)
  })

  it("refuses explicit addresses for another worker's Dispatch or an unrelated Run", async () => {
    setup()
    dispatchFromCoordinator('worker', WORKER_PANE)
    const sibling = dispatchFromCoordinator('sibling', SIBLING_PANE)
    const other = db.createRun({
      objective: 'Other',
      coordinatorHandle: 'term_local',
      coordinatorPaneKey: LOCAL_PANE
    })
    for (const to of [`dispatch:${sibling.dispatchId}`, `run:${other.id}`]) {
      const sent = await callAsBridge('orchestration.send', {
        from: 'term_worker',
        to,
        subject: 'p'
      })
      expect(forbidden(sent)).toBe(true)
    }
  })

  it('refuses a forged pane claiming the Dispatch mailbox', async () => {
    setup()
    const worker = dispatchFromCoordinator('worker', WORKER_PANE)
    // A process on the worker's handle that does not hold the Dispatch's pane owns no Dispatch mail.
    vi.mocked(runtime.getTerminalPaneKey).mockImplementation((handle) =>
      handle === 'term_worker'
        ? SIBLING_PANE
        : handle === 'term_coord'
          ? harness.coordinatorPaneKey
          : null
    )
    const original = db.insertMessage({
      from: 'term_coord',
      to: `dispatch:${worker.dispatchId}`,
      subject: 's',
      body: 's'
    })
    const reply = await callAsBridge('orchestration.reply', {
      from: 'term_worker',
      id: original.id,
      body: 'forged'
    })
    expect(forbidden(reply)).toBe(true)
  })

  it("lets an SSH coordinator address a same-host worker's Dispatch but not another host's", async () => {
    setup()
    placeCoordinatorOnHost()
    const worker = dispatchFromCoordinator('worker', WORKER_PANE)
    const sibling = dispatchFromCoordinator('sibling', SIBLING_PANE)
    const send = (to: string) =>
      callAsBridge('orchestration.send', { from: 'term_coord', to, subject: 'p' })
    expect(forbidden(await send(`dispatch:${worker.dispatchId}`))).toBe(false)
    expect(forbidden(await send(`dispatch:${sibling.dispatchId}`))).toBe(true)
  })
})
