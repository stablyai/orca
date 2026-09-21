import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_METHODS } from '../../orchestration'
import type { RpcContext } from '../../../core'
import { OrchestrationDb } from '../../../../orchestration/db'
import { OrcaRuntimeService } from '../../../../orca-runtime'
import {
  encodeFederatedControlMessage,
  importFederatedControlMessage
} from '../../../../orchestration/federation-control-message'

const DISPATCH_ID = 'ctx_federated_worker_1'
const WORKER_HANDLE = 'term_federated_worker'
const WORKER_PANE = 'tab_w:eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const INCARNATION = 'runtime_test:term_federated_worker:1'

type CheckResult = {
  runId: string
  deliveryId: string | null
  messages: { id: string; subject: string }[]
  count: number
  replayed: boolean
  acknowledged: string | null
}

describe('orchestration.check on a federated attachment across a restart', () => {
  let directory: string | undefined
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
    db = undefined
    if (directory) {
      rmSync(directory, { recursive: true, force: true })
      directory = undefined
    }
  })

  function launch(path: string): RpcContext {
    db = new OrchestrationDb(path)
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
      handle === WORKER_HANDLE ? WORKER_PANE : null
    )
    vi.spyOn(runtime, 'getLiveTerminalPaneKey').mockImplementation((handle) =>
      runtime.getTerminalPaneKey(handle)
    )
    vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockImplementation((handle) =>
      handle === WORKER_HANDLE ? INCARNATION : null
    )
    return { runtime }
  }

  function check(ctx: RpcContext, params: Record<string, unknown> = {}): Promise<CheckResult> {
    const method = ORCHESTRATION_METHODS.find((entry) => entry.name === 'orchestration.check')
    if (!method) {
      throw new Error('orchestration.check is not registered')
    }
    const parsed = method.params
      ? method.params.parse({ terminal: WORKER_HANDLE, ...params })
      : undefined
    return method.handler(parsed, ctx) as Promise<CheckResult>
  }

  function attach(store: OrchestrationDb, dispatchId: string, runId: string): void {
    store.createRemoteDispatchAttachment({
      dispatchId,
      runId,
      taskId: 'task_federated_1',
      homePeerFingerprint: 'peer_fp',
      protocolVersion: 1,
      runtimeEpoch: 'epoch_1',
      mutationReceipt: {
        callerFingerprint: 'peer_fp',
        requestId: 'attach_1',
        method: 'orchestration.federationAttachStart',
        payloadHash: 'attach_payload'
      }
    })
    expect(store.getRunRaw(runId)).toBeDefined()
    store.prepareRemoteAttachmentAuthority({
      dispatchId,
      paneKey: WORKER_PANE,
      processIncarnation: INCARNATION,
      worktreeId: 'folder_workspace',
      terminalHandle: WORKER_HANDLE,
      setupState: 'not_applicable',
      effects: []
    })
    store.markRemoteAttachmentReady(dispatchId)
  }

  it('replays the coordinator instruction and takes its ack after the app restarts', async () => {
    directory = mkdtempSync(join(tmpdir(), 'orca-federated-check-'))
    const path = join(directory, 'orchestration.db')

    const first = launch(path)
    attach(db as OrchestrationDb, DISPATCH_ID, 'run_coordinator')
    importFederatedControlMessage(db as OrchestrationDb, {
      dispatchId: DISPATCH_ID,
      messageId: 'msg_federated_1',
      payload: encodeFederatedControlMessage({
        from: 'term_coord',
        subject: 'continue the task',
        body: 'the plan changed',
        type: 'dispatch',
        priority: 'normal',
        threadId: null,
        payload: null
      })
    })

    const delivered = await check(first)
    expect(delivered.messages.map((message) => message.id)).toEqual(['msg_federated_1'])
    expect(delivered.runId).toBe('run_coordinator')
    expect(delivered.replayed).toBe(false)
    const deliveryId = delivered.deliveryId as string
    expect(deliveryId).not.toBeNull()
    ;(db as OrchestrationDb).close()

    // The worker's process outlives the app; its instruction is still unacknowledged.
    const second = launch(path)
    const replayed = await check(second)
    expect(replayed.deliveryId).toBe(deliveryId)
    expect(replayed.replayed).toBe(true)
    expect(replayed.messages.map((message) => message.id)).toEqual(['msg_federated_1'])

    const acknowledged = await check(second, { ack: deliveryId })
    expect(acknowledged.acknowledged).toBe(deliveryId)
    expect(acknowledged.count).toBe(0)
  })

  it('files loopback mail once under the local Dispatch Run without replacing its owner', async () => {
    const ctx = launch(':memory:')
    const store = db as OrchestrationDb
    const run = store.createRun({
      objective: 'loopback coordinator',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:pane_coord'
    })
    const task = store.createTask({ runId: run.id, spec: 'loopback task' })
    const { dispatch } = store.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskId: task.id,
      startOptions: {}
    })
    attach(store, dispatch.id, run.id)
    expect(store.getRemoteDispatchAttachment(dispatch.id)?.home_run_id).toBe(dispatch.run_id)
    expect(store.getRun(run.id)).toEqual(run)
    const message = {
      dispatchId: dispatch.id,
      messageId: 'msg_loopback',
      payload: encodeFederatedControlMessage({
        from: 'term_coord',
        subject: 'continue',
        body: 'loopback instruction',
        type: 'dispatch',
        priority: 'normal',
        threadId: null,
        payload: null
      })
    }
    expect(importFederatedControlMessage(store, message).imported).toBe(true)
    expect(importFederatedControlMessage(store, message).imported).toBe(false)
    expect(store.getMessageById(message.messageId)?.run_id).toBe(run.id)
    const delivered = await check(ctx)
    expect(delivered.runId).toBe(run.id)
    expect(delivered.messages.map((entry) => entry.id)).toEqual([message.messageId])
    expect((await check(ctx, { ack: delivered.deliveryId })).count).toBe(0)
  })

  it('refuses an attachment with no home Run before writing a Delivery', async () => {
    const ctx = launch(':memory:')
    const store = db as OrchestrationDb
    attach(store, DISPATCH_ID, 'run_coordinator')
    const attachment = store.getRemoteDispatchAttachment(DISPATCH_ID)!
    vi.spyOn(store, 'findActiveRemoteAttachmentForPane').mockReturnValue({
      ...attachment,
      home_run_id: undefined
    } as never)
    await expect(check(ctx)).rejects.toThrow()
    expect(store.db.prepare('SELECT id FROM deliveries').all()).toEqual([])
  })
})
