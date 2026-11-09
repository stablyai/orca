import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ORCHESTRATION_CONTRACT_VERSION,
  ORCHESTRATION_FEDERATION_FOLLOW_UP_RUNTIME_CAPABILITY
} from '../../../../../../shared/orchestration/orchestration-runtime-capabilities'
import type { RuntimeRpcResponse } from '../../../../../../shared/runtime-rpc-envelope'
import { OrcaRuntimeService } from '../../../../orca-runtime'
import { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import '../../../../orchestration/db/contract-constants'
import '../../../../orchestration/db/messages/mailbox-routing-page'
import '../../../../orchestration/db/dispatch-row-writer'
import '../../../../orchestration/db/attempt-outcome-projection'
import type { OrchestrationEnvironmentTransport } from '../../../../orchestration/federation/environment-transport'
import '../../../../orchestration/federation/federation-lifecycle-settlement'
import { RpcDispatcher } from '../../../dispatcher'
import { ORCHESTRATION_METHODS } from '../orchestration'
import { createFederationWorkerStartRequest as startRequest } from './federation-request.test-support'
import { configureFederationWorkerRuntime } from './federation-runtime.test-support'

const WORKER = 'term_windows_worker'

// A finished worker on a paired server is continued and still talks home, as a finished local worker is and does.
describe('a finished worker on a paired server', () => {
  let homeDb: OrchestrationDb
  let workerDb: OrchestrationDb
  let homeRuntime: OrcaRuntimeService
  let workerRuntime: OrcaRuntimeService
  let home: RpcDispatcher
  let worker: RpcDispatcher
  let workerCapabilities: string[]
  let request = 0

  beforeEach(() => {
    homeDb = new OrchestrationDb(':memory:')
    workerDb = new OrchestrationDb(':memory:')
    workerRuntime = new OrcaRuntimeService()
    workerRuntime.setOrchestrationDb(workerDb)
    configureFederationWorkerRuntime(workerRuntime, WORKER)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the attach reads only the workspace id in this rig.
    vi.spyOn(workerRuntime, 'showManagedTerminalWorkspace').mockResolvedValue({
      id: 'repo::windows-worktree'
    } as never)
    vi.spyOn(workerRuntime, 'isTerminalRunningAgent').mockResolvedValue(true)
    vi.spyOn(workerRuntime, 'readLaunchedAgentForeground').mockResolvedValue('agent')
    vi.spyOn(workerRuntime, 'subscribeToTerminalData').mockReturnValue(() => {})
    worker = new RpcDispatcher({ runtime: workerRuntime, methods: ORCHESTRATION_METHODS })
    workerCapabilities = [...(workerRuntime.getStatus().capabilities ?? [])]
    const transport: OrchestrationEnvironmentTransport = {
      resolve: () => ({
        environmentId: 'environment_windows',
        name: 'windows',
        peerFingerprint: 'windows_peer_fingerprint'
      }),
      call: async (_selector, method, params, _timeoutMs, envelope) =>
        method === 'status.get'
          ? {
              id: 'status',
              ok: true,
              result: { ...workerRuntime.getStatus(), capabilities: workerCapabilities },
              _meta: { runtimeId: workerRuntime.getRuntimeId() }
            }
          : await worker.dispatch({
              id: `remote_${method}`,
              authToken: 'run-home-device-token',
              method,
              params,
              orchestrationContractVersion: envelope?.orchestrationContractVersion,
              orchestrationRequestId: envelope?.orchestrationRequestId
            })
    }
    homeRuntime = new OrcaRuntimeService(null, undefined, {
      orchestrationEnvironmentTransport: transport
    })
    homeRuntime.setOrchestrationDb(homeDb)
    home = new RpcDispatcher({ runtime: homeRuntime, methods: ORCHESTRATION_METHODS })
    vi.spyOn(homeRuntime, 'getTerminalPaneKey').mockReturnValue(
      'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    )
  })

  afterEach(() => {
    homeRuntime.stopOrchestrationFederationRelay()
    homeDb.close()
    workerDb.close()
    vi.restoreAllMocks()
  })

  const call = (runtime: RpcDispatcher, method: string, params: Record<string, unknown>) =>
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these orchestration methods answer with object results.
    runtime.dispatch({
      id: `rpc_${++request}`,
      authToken: 'local-token',
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      orchestrationRequestId: `request_${request}`,
      method,
      params
    }) as Promise<RuntimeRpcResponse<Record<string, unknown>>>

  async function finishedRemoteWorker(): Promise<string> {
    const run = homeDb.createRun({
      objective: 'Mac to Windows',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    })
    const task = homeDb.createTask({ spec: 'Audit Windows behavior', runId: run.id })
    await home.dispatch(startRequest(task.id))
    homeRuntime.stopOrchestrationFederationRelay()
    const dispatchId = homeDb.getDispatchContext(task.id)!.id
    const done = call(worker, 'orchestration.send', {
      from: WORKER,
      subject: 'Done',
      type: 'worker_done',
      payload: JSON.stringify({ taskId: task.id, dispatchId, outcome: 'succeeded' })
    })
    await vi.waitFor(() =>
      expect(workerDb.listPendingFederationRelay(dispatchId, 'to_home')).toHaveLength(1)
    )
    await homeRuntime.syncOrchestrationFederation()
    await expect(done).resolves.toMatchObject({ ok: true })
    expect(workerDb.getRemoteDispatchAttachment(dispatchId)?.state).toBe('succeeded')
    return dispatchId
  }

  const followUp = (dispatchId: string) =>
    call(home, 'orchestration.send', {
      from: 'term_coord',
      to: `dispatch:${dispatchId}`,
      subject: 'Also the docs'
    })

  /** Settle the in-place follow-up the way its worker would. */
  async function finishFollowUp(dispatchId: string): Promise<void> {
    const task = homeDb.getDispatchContextById(dispatchId)!.task_id
    const done = call(worker, 'orchestration.send', {
      from: WORKER,
      subject: 'Done again',
      type: 'worker_done',
      payload: JSON.stringify({ taskId: task, dispatchId, outcome: 'succeeded' })
    })
    await vi.waitFor(() =>
      expect(workerDb.listPendingFederationRelay(dispatchId, 'to_home')).toHaveLength(1)
    )
    await homeRuntime.syncOrchestrationFederation()
    await expect(done).resolves.toMatchObject({ ok: true })
  }

  const homeMail = () =>
    homeDb.db
      .prepare("SELECT subject, type FROM messages WHERE from_handle LIKE 'dispatch:%'")
      .all()

  it('takes a follow-up on the same terminal there, tracked as the next Dispatch', async () => {
    const dispatchId = await finishedRemoteWorker()

    const sent = await call(home, 'orchestration.send', {
      from: 'term_coord',
      to: `dispatch:${dispatchId}`,
      subject: 'Also the docs',
      body: 'Update the docs too.'
    })

    expect(sent).toMatchObject({ ok: true, result: { followUpOf: dispatchId, state: 'ready' } })
    const followUp = String(sent.ok && sent.result.dispatchId)
    expect(homeDb.getDispatchContextById(followUp)?.follow_up_of_dispatch_id).toBe(dispatchId)
    expect(workerDb.getRemoteDispatchAttachment(followUp)).toMatchObject({
      state: 'ready',
      terminal_handle: WORKER
    })
  })

  it('starts no second agent while its server cannot read the first one', async () => {
    const dispatchId = await finishedRemoteWorker()
    // The pane now reads as another process, and nothing proves the recorded one exited.
    vi.mocked(workerRuntime.getTerminalProcessIncarnation).mockReturnValue('windows_runtime:pty:2')
    vi.spyOn(workerRuntime, 'inspectTerminalProcessIncarnationLiveness').mockResolvedValue(
      'unverifiable'
    )

    await expect(followUp(dispatchId)).resolves.toMatchObject({
      ok: false,
      error: { message: expect.stringContaining('so it starts no second one') }
    })
    expect(
      workerDb.db.prepare('SELECT count(*) AS n FROM remote_dispatch_attachments').get()
    ).toEqual({
      n: 1
    })
  })

  it('after an in-place follow-up, starts a fresh agent of the first kind once that agent exits', async () => {
    const dispatchId = await finishedRemoteWorker()
    const first = await followUp(dispatchId)
    const inPlace = String(first.ok && first.result.dispatchId)
    await finishFollowUp(inPlace)
    vi.spyOn(workerRuntime, 'checkTerminalAgentPresence').mockResolvedValue('exited')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fresh launch reads only the handle in this rig.
    vi.spyOn(workerRuntime, 'createTerminal').mockResolvedValue({
      handle: 'term_fresh',
      worktreeId: 'repo::windows-worktree'
    } as never)

    const second = await followUp(inPlace)

    expect(second).toMatchObject({
      ok: true,
      result: { followUpOf: inPlace, delivery: 'started_fresh', state: 'ready' }
    })
    expect(workerRuntime.createTerminal).toHaveBeenCalledWith(
      'id:repo::windows-worktree',
      expect.objectContaining({ startupAgent: 'codex' })
    )
  })

  it('on an older server, keeps refusing the follow-up and names worker-start --on', async () => {
    workerCapabilities = workerCapabilities.filter(
      (capability) => capability !== ORCHESTRATION_FEDERATION_FOLLOW_UP_RUNTIME_CAPABILITY
    )
    const dispatchId = await finishedRemoteWorker()

    const sent = await call(home, 'orchestration.send', {
      from: 'term_coord',
      to: `dispatch:${dispatchId}`,
      subject: 'Also the docs'
    })

    expect(sent).toMatchObject({
      ok: false,
      error: {
        code: 'dispatch_inactive',
        message: expect.stringContaining('orca orchestration worker-start --on windows')
      }
    })
    expect(workerDb.getRemoteDispatchAttachment(dispatchId)?.state).toBe('succeeded')
  })

  it('carries its late mail and its question home, and its answer back', async () => {
    await finishedRemoteWorker()

    await expect(
      call(worker, 'orchestration.send', { from: WORKER, subject: 'One more thing' })
    ).resolves.toMatchObject({ ok: true, result: { relay: { destination: 'run_home' } } })
    const asked = await call(worker, 'orchestration.ask', {
      from: WORKER,
      question: 'Should I also check Linux?',
      wait: false
    })
    expect(asked).toMatchObject({ ok: true })
    await homeRuntime.syncOrchestrationFederation()

    expect(homeMail()).toEqual(
      expect.arrayContaining([
        { subject: 'One more thing', type: 'status' },
        { subject: 'Question', type: 'question' }
      ])
    )
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: selects the one id column.
    const question = homeDb.db.prepare("SELECT id FROM messages WHERE type = 'question'").get() as {
      id: string
    }
    await expect(
      call(home, 'orchestration.reply', { from: 'term_coord', id: question.id, body: 'Yes.' })
    ).resolves.toMatchObject({ ok: true })
    await homeRuntime.syncOrchestrationFederation()
    expect(workerDb.getRemoteQuestion(question.id)).toMatchObject({
      status: 'answered',
      answer_body: 'Yes.'
    })
  })

  it('stops carrying its mail once another worker start reuses its own terminal there', async () => {
    const run = homeDb.createRun({
      objective: 'Reuse',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    })
    const reuse = { worktree: 'id:repo::windows-worktree', terminal: WORKER, agent: undefined }
    const first = homeDb.createTask({ spec: 'First on the user terminal', runId: run.id })
    await home.dispatch(startRequest(first.id, { ...reuse, repo: undefined, name: undefined }))
    homeRuntime.stopOrchestrationFederationRelay()
    const dispatchId = homeDb.getDispatchContext(first.id)!.id
    workerDb.db
      .prepare("UPDATE remote_dispatch_attachments SET state = 'succeeded' WHERE dispatch_id = ?")
      .run(dispatchId)
    homeDb.db
      .prepare("UPDATE worker_dispatches SET state = 'succeeded' WHERE dispatch_id = ?")
      .run(dispatchId)
    expect(homeDb.federatedDispatchTakesLateMail(dispatchId)).toBe(true)

    const second = homeDb.createTask({ spec: 'Second on the same terminal', runId: run.id })
    await home.dispatch({
      ...startRequest(second.id, { ...reuse, repo: undefined, name: undefined }),
      orchestrationRequestId: 'request_second_start'
    })
    homeRuntime.stopOrchestrationFederationRelay()
    await homeRuntime.syncOrchestrationFederation()

    expect(homeDb.federatedDispatchTakesLateMail(dispatchId)).toBe(false)
  })

  it('stops carrying its mail once a later local Dispatch there takes its terminal', async () => {
    const dispatchId = await finishedRemoteWorker()
    const run = workerDb.createRun({
      objective: 'Local',
      coordinatorHandle: null,
      coordinatorPaneKey: null
    })
    workerDb.createDispatchContext({
      taskId: workerDb.createTask({ runId: run.id, spec: 'local work' }).id,
      assigneeHandle: WORKER,
      assigneePaneKey: 'tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      creator: { kind: 'system' },
      maxDepth: 10
    })

    await expect(
      call(worker, 'orchestration.send', { from: WORKER, subject: 'Whose mail is this?' })
    ).resolves.not.toMatchObject({ ok: true, result: { relay: { destination: 'run_home' } } })
    await homeRuntime.syncOrchestrationFederation()
    expect(homeDb.federatedDispatchTakesLateMail(dispatchId)).toBe(false)
  })

  it('stops carrying its mail once a local Dispatch takes its pane under a reminted handle', async () => {
    const pane = 'tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    const run = workerDb.createRun({
      objective: 'Local',
      coordinatorHandle: null,
      coordinatorPaneKey: null
    })
    const local = (handle: string) =>
      workerDb.createDispatchContext({
        taskId: workerDb.createTask({ runId: run.id, spec: 'local work' }).id,
        assigneeHandle: handle,
        assigneePaneKey: pane,
        creator: { kind: 'system' },
        maxDepth: 10
      })
    const earlier = local(WORKER)
    workerDb.db
      .prepare(
        "UPDATE dispatch_contexts SET status = 'completed', created_at = '2000-01-01 00:00:00' WHERE id = ?"
      )
      .run(earlier.id)
    const dispatchId = await finishedRemoteWorker()
    local('term_windows_worker_reminted')

    await homeRuntime.syncOrchestrationFederation()

    expect(homeDb.federatedDispatchTakesLateMail(dispatchId)).toBe(false)
  })

  it('stops pulling for it once its server released it', async () => {
    const dispatchId = await finishedRemoteWorker()
    expect(homeDb.federatedDispatchTakesLateMail(dispatchId)).toBe(true)
    workerDb.db
      .prepare("UPDATE remote_dispatch_attachments SET stage = 'released' WHERE dispatch_id = ?")
      .run(dispatchId)

    await homeRuntime.syncOrchestrationFederation()

    expect(homeDb.federatedDispatchTakesLateMail(dispatchId)).toBe(false)
    expect(homeDb.listActiveFederatedDispatches().map((row) => row.dispatch_id)).toEqual([])
  })
})
