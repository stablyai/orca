import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY,
  ORCHESTRATION_FEDERATION_RUNTIME_CAPABILITY
} from '../../../../shared/protocol-version'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationDb } from '../../orchestration/db'
import { RpcDispatcher } from '../dispatcher'
import { ORCHESTRATION_METHODS } from './orchestration'
import { startFederatedWorker } from './orchestration-federated-worker-start'
import { createRootDispatch } from '../../orchestration/db/root-dispatch-test-fixture'

describe('orchestration migration behavior', () => {
  const databases: OrchestrationDb[] = []

  afterEach(() => {
    for (const database of databases.splice(0)) {
      database.close()
    }
  })

  function createRuntime(): { db: OrchestrationDb; runtime: OrcaRuntimeService } {
    const db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    databases.push(db)
    return { db, runtime }
  }

  it('lists an explicitly selected legacy Run without binding or mutation', async () => {
    const { db, runtime } = createRuntime()
    const task = db.createTask({ spec: 'pre-upgrade work' })
    const taskList = ORCHESTRATION_METHODS.find(
      (method) => method.name === 'orchestration.taskList'
    )!

    const listed = (await taskList.handler(taskList.params!.parse({ run: 'run_legacy_local' }), {
      runtime
    })) as {
      runId: string
      legacyReadOnly: boolean
      tasks: { id: string }[]
    }

    expect(listed).toMatchObject({
      runId: 'run_legacy_local',
      legacyReadOnly: true,
      tasks: [{ id: task.id }]
    })
    expect(db.getTask(task.id)?.status).toBe('ready')
  })

  it('formats legacy terminal inspection as read-only without consuming mail', async () => {
    const { db, runtime } = createRuntime()
    const message = db.insertMessage({
      from: 'term_worker',
      to: 'term_coord',
      subject: 'still working',
      body: 'Tests are running.'
    })
    const check = ORCHESTRATION_METHODS.find((method) => method.name === 'orchestration.check')!

    const inspected = (await check.handler(
      check.params!.parse({ terminal: 'term_coord', peek: true, format: true }),
      { runtime }
    )) as { count: number; formatted: string }

    expect(inspected.count).toBe(1)
    expect(inspected.formatted).toContain('[LEGACY READ-ONLY]')
    expect(inspected.formatted).toContain('Tests are running.')
    expect(inspected.formatted).not.toContain('[Reply:')
    expect(db.getMessageById(message.id)?.read).toBe(0)
  })

  it('rejects acknowledgment of legacy mail without effects', async () => {
    const { db, runtime } = createRuntime()
    const message = db.insertMessage({
      from: 'term_worker',
      to: 'term_coord',
      subject: 'still working'
    })
    const check = ORCHESTRATION_METHODS.find((method) => method.name === 'orchestration.check')!

    await expect(
      check.handler(check.params!.parse({ terminal: 'term_coord' }), { runtime })
    ).rejects.toMatchObject({
      code: 'legacy_read_only',
      data: { effectsApplied: false }
    })
    expect(db.getMessageById(message.id)?.read).toBe(0)
    expect(db.getInbox(100)).toHaveLength(1)
  })

  it('rejects replies to legacy mail without marking or inserting rows', async () => {
    const { db, runtime } = createRuntime()
    const message = db.insertMessage({
      from: 'term_worker',
      to: 'term_coord',
      subject: 'legacy question'
    })
    const reply = ORCHESTRATION_METHODS.find((method) => method.name === 'orchestration.reply')!

    await expect(
      reply.handler(
        reply.params!.parse({
          id: message.id,
          body: 'replacement started',
          from: 'term_coord'
        }),
        { runtime }
      )
    ).rejects.toMatchObject({
      code: 'legacy_read_only',
      data: { effectsApplied: false }
    })
    expect(db.getMessageById(message.id)?.read).toBe(0)
    expect(db.getInbox(100)).toHaveLength(1)
  })

  it('rejects a pre-contract worker_done before message or lifecycle mutation', async () => {
    const { db, runtime } = createRuntime()
    const run = db.createRun({
      objective: 'legacy worker',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:leaf_coord'
    })
    const task = db.createTask({ spec: 'legacy worker', runId: run.id })
    const dispatch = createRootDispatch(db, task.id, 'term_worker', 'tab_worker:leaf_worker')
    const dispatcher = new RpcDispatcher({ runtime, methods: ORCHESTRATION_METHODS })

    const response = await dispatcher.dispatch({
      id: 'legacy_worker_done',
      authToken: 'worker-token',
      method: 'orchestration.send',
      params: {
        from: 'term_worker',
        subject: 'done',
        type: 'worker_done',
        payload: JSON.stringify({
          taskId: task.id,
          dispatchId: dispatch.id,
          outcome: 'succeeded'
        })
      }
    })

    expect(response).toMatchObject({
      ok: false,
      error: {
        code: 'orchestration_migration_required',
        data: { effectsApplied: false }
      }
    })
    expect(db.getInbox(100)).toHaveLength(0)
    expect(db.getTask(task.id)?.status).toBe('dispatched')
    expect(db.getDispatchContextById(dispatch.id)?.status).toBe('dispatched')
  })

  it('rejects a connected server missing the contract before home or remote effects', async () => {
    const { db, runtime } = createRuntime()
    const run = db.createRun({
      objective: 'mixed-version worker',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:leaf_coord'
    })
    const task = db.createTask({ spec: 'remote work', runId: run.id })
    vi.spyOn(runtime, 'resolveOrchestrationWorkerServer').mockReturnValue({
      environmentId: 'environment_windows',
      name: 'windows',
      peerFingerprint: 'windows_peer'
    })
    vi.spyOn(runtime, 'callOrchestrationWorkerServer').mockResolvedValue({
      capabilities: [ORCHESTRATION_FEDERATION_RUNTIME_CAPABILITY]
    })

    await expect(
      startFederatedWorker({
        params: {
          task: task.id,
          from: 'term_coord',
          on: 'windows',
          worktree: 'new-top-level',
          repo: 'id:windows-repo',
          name: 'remote-work',
          agent: 'codex'
        },
        runtime,
        db,
        runId: run.id,
        task,
        orchestrationMutation: {
          callerFingerprint: 'caller',
          requestId: 'remote_start',
          method: 'orchestration.workerStart',
          payloadHash: 'payload'
        }
      })
    ).rejects.toMatchObject({
      code: 'orchestration_migration_required',
      data: { reason: 'runtime_capability_missing', effectsApplied: false }
    })
    expect(db.getTask(task.id)?.status).toBe('ready')
    expect(db.getDispatchContext(task.id)).toBeUndefined()
  })

  it('rejects a connected server missing federation support before Task mutation', async () => {
    const { db, runtime } = createRuntime()
    const run = db.createRun({
      objective: 'unsupported worker',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:leaf_coord'
    })
    const task = db.createTask({ spec: 'remote work', runId: run.id })
    vi.spyOn(runtime, 'resolveOrchestrationWorkerServer').mockReturnValue({
      environmentId: 'environment_windows',
      name: 'windows',
      peerFingerprint: 'windows_peer'
    })
    vi.spyOn(runtime, 'callOrchestrationWorkerServer').mockResolvedValue({
      capabilities: [ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY]
    })

    await expect(
      startFederatedWorker({
        params: {
          task: task.id,
          from: 'term_coord',
          on: 'windows',
          worktree: 'new-top-level',
          repo: 'id:windows-repo',
          name: 'remote-work',
          agent: 'codex'
        },
        runtime,
        db,
        runId: run.id,
        task,
        orchestrationMutation: {
          callerFingerprint: 'caller',
          requestId: 'remote_start',
          method: 'orchestration.workerStart',
          payloadHash: 'payload'
        }
      })
    ).rejects.toMatchObject({ code: 'capability_unsupported' })
    expect(db.getTask(task.id)?.status).toBe('ready')
    expect(db.getDispatchContext(task.id)).toBeUndefined()
  })
})
