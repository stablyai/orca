import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OrcaRuntimeService } from '../../../../orca-runtime'
import { OrchestrationDb } from '../../../../orchestration/db'
import type { OrchestrationSessionCaller } from '../../../../orchestration/orchestration-caller-identity'
import { ORCHESTRATION_METHODS } from '../../orchestration'
import { eraseRpcMethods, type RpcContext } from '../../../core'
import { parseOrcaSessionAddress } from '../../../../../../shared/orca-session-address'

describe('orchestration.workerAbandon', () => {
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService

  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
  })
  afterEach(() => db.close())

  function readyWorker(): string {
    const task = db.createTask({ runId: 'run_legacy_local', spec: 'abandon caller' })
    const { dispatch } = db.createStartingWorkerDispatch({
      taskId: task.id,
      startOptions: {},
      creator: { kind: 'system' },
      maxDepth: 9
    })
    db.prepareStartingWorkerAuthority({
      dispatchId: dispatch.id,
      handle: 'term_worker',
      paneKey: 'tab_worker:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      processIncarnation: 'inc_worker',
      worktreeId: 'wt',
      effects: [],
      setupState: 'not_configured'
    })
    db.markWorkerDispatchReady(dispatch.id)
    return dispatch.id
  }

  async function abandon(dispatchId: string, ctx: Partial<RpcContext>) {
    const method = eraseRpcMethods(ORCHESTRATION_METHODS).find(
      (m) => m.name === 'orchestration.workerAbandon'
    )!
    return method.handler(method.params!.parse({ dispatch: dispatchId }), { runtime, ...ctx })
  }

  it('never records an unverified terminal handle as the one who abandoned the worker', async () => {
    const dispatchId = readyWorker()

    await expect(
      abandon(dispatchId, { orchestrationCompatibilityEvidence: { terminalHandle: 'term_coord' } })
    ).resolves.toMatchObject({ state: 'abandoned', alreadySettled: false })
    expect(db.getWorkerDispatch(dispatchId)?.last_error).toBe(
      'Abandoned by an unidentified caller.'
    )
  })

  it('records the resolved Orca session as the one who abandoned the worker', async () => {
    const dispatchId = readyWorker()
    const orcaSessionId = parseOrcaSessionAddress('orca_session_id:chat_1')!
    const session: OrchestrationSessionCaller = {
      address: 'orca_session_id:chat_1',
      terminalHandle: null,
      paneKey: null,
      orcaSessionId,
      sessionId: orcaSessionId,
      workspaceId: 'wt'
    }

    await abandon(dispatchId, {
      orchestrationCaller: session,
      orchestrationCompatibilityEvidence: { terminalHandle: 'term_coord' }
    })
    expect(db.getWorkerDispatch(dispatchId)?.last_error).toBe(
      'Abandoned by orca_session_id:chat_1.'
    )
  })

  it('reports an already-settled worker as stale and changes nothing', async () => {
    const dispatchId = readyWorker()
    db.failDispatch(dispatchId, 'tab closed', { workerProcessExited: true })
    const before = db.getWorkerDispatch(dispatchId)

    await expect(abandon(dispatchId, {})).resolves.toMatchObject({
      state: 'failed',
      alreadySettled: true,
      stale: true
    })
    expect(db.getWorkerDispatch(dispatchId)).toEqual(before)
  })
})
