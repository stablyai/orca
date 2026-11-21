import {
  WorkerDockSubscribe,
  WorkerDockRead,
  WorkerDockAcknowledge,
  WorkerDockResultRead,
  WorkerDockStop,
  WorkerDockResultsRead
} from '../../../../../shared/orchestration/dock/worker-dock'
import {
  defineOrchestrationMethod,
  defineOrchestrationStreamingMethod
} from './access/orchestration-method-access'
import {
  readWorkerDock,
  readWorkerDockResultRefs,
  acknowledgeWorkerDock,
  readWorkerDockResult,
  workerDockSession
} from '../../../orchestration/dock/worker-dock-read'
import { refreshWorkerDockActivity } from '../../../orchestration/dock/worker-dock-activity'
import { subscribeWorkerDock } from '../../../orchestration/dock/worker-dock-stream'
import { stopWorkerAndHelpers } from './worker/worker-stop'
import { OrchestrationError } from '../../../orchestration/orchestration-error'
import type { RpcContext } from '../../core'

function requireOwner({ ctx }: { ctx: RpcContext }): void {
  const caller = ctx.caller
  if (caller?.kind !== 'desktop') {
    throw new OrchestrationError(
      'owner_required',
      'Use Orca to clear or stop workers in this dock.'
    )
  }
}

let sequence = 0
export const ORCHESTRATION_WORKER_DOCK_METHODS = [
  defineOrchestrationMethod({
    name: 'orchestration.workerDockResultsRead',
    permission: 'workspace',
    access: { kind: 'localOnly', targets: { party: 'party' } },
    params: WorkerDockResultsRead,
    handler: ({ party, before }, { runtime }) =>
      readWorkerDockResultRefs(runtime.getOrchestrationDb(), party, before)
  }),
  defineOrchestrationMethod({
    name: 'orchestration.workerDockRead',
    permission: 'workspace',
    access: { kind: 'localOnly', targets: { party: 'party' } },
    params: WorkerDockRead,
    handler: (request, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      const source = workerDockSession(request.party)
      if (request.seed && !db.workerDockSources.needsSeed(source)) {
        return { revision: 0, expired: false, identities: [], rows: [], results: [], anchor: null }
      }
      if (!request.seed) {
        refreshWorkerDockActivity(db, request.party, runtime)
      }
      const result = readWorkerDock(db, request)
      return result
    }
  }),
  defineOrchestrationMethod({
    name: 'orchestration.workerDockAcknowledge',
    permission: 'workspace',
    access: { kind: 'localOnly', targets: { party: 'party' }, rule: requireOwner },
    params: WorkerDockAcknowledge,
    handler: (request, { runtime }) => {
      acknowledgeWorkerDock(runtime.getOrchestrationDb(), request)
      return { acknowledged: request.acknowledged }
    }
  }),
  defineOrchestrationMethod({
    name: 'orchestration.workerDockResult',
    permission: 'workspace',
    access: { kind: 'localOnly', targets: { party: 'party', dispatch: 'dispatch' } },
    params: WorkerDockResultRead,
    handler: ({ party, dispatch }, { runtime }) =>
      readWorkerDockResult(runtime.getOrchestrationDb(), party, dispatch)
  }),
  defineOrchestrationMethod({
    name: 'orchestration.workerDockStop',
    permission: 'workspace',
    access: {
      kind: 'localOnly',
      targets: { party: 'party', dispatch: 'dispatch' },
      rule: requireOwner
    },
    params: WorkerDockStop,
    handler: async ({ party, dispatch, requestId }, { runtime, orchestrationMutation }) => {
      const db = runtime.getOrchestrationDb()
      const source = workerDockSession(party)
      if (db.getFederatedDispatch(dispatch)) {
        throw new OrchestrationError(
          'remote_owner_actions_unsupported',
          'Stop or clear this from the computer it runs on.'
        )
      }
      const fact = db.db
        .prepare('SELECT source, settlement FROM worker_dock_facts WHERE dispatch_id = ?')
        .get(dispatch)
      if (!fact || fact.source !== source) {
        throw new OrchestrationError(
          'dispatch_not_found',
          'This worker is not part of this source session.'
        )
      }
      db.db
        .prepare(
          'INSERT OR IGNORE INTO worker_dock_owner_stops(request_id, source, dispatch_id) VALUES(?, ?, ?)'
        )
        .run(requestId, source, dispatch)
      const request = db.db
        .prepare(
          'SELECT source, dispatch_id, receipt FROM worker_dock_owner_stops WHERE request_id = ?'
        )
        .get(requestId)
      if (request?.source !== source || request.dispatch_id !== dispatch) {
        throw new OrchestrationError(
          'invalid_argument',
          'Stop request identity was already used for another worker.'
        )
      }
      if (typeof request.receipt === 'string') {
        return JSON.parse(request.receipt)
      }
      const receipt = await stopWorkerAndHelpers(runtime, dispatch, orchestrationMutation)
      const confirmed =
        receipt.state === 'stopped' &&
        !receipt.alreadySettled &&
        receipt.processAction !== 'none' &&
        !receipt.lastError &&
        !receipt.warning &&
        !receipt.helperStopError &&
        (receipt.helpers ?? []).every(
          (helper) => helper.outcome === 'stopped' || helper.outcome === 'already_finished'
        )
      db.db
        .prepare(`UPDATE worker_dock_owner_stops SET receipt = ?, confirmed = ?, settlement =
        (SELECT settlement FROM worker_dock_facts WHERE dispatch_id = ?) WHERE request_id = ?`)
        .run(JSON.stringify(receipt), Number(confirmed), dispatch, requestId)
      db.workerDockSources.invalidate(source)
      db.crewChanges.notify(new Set(['topology']))
      return receipt
    }
  }),
  defineOrchestrationStreamingMethod({
    name: 'orchestration.workerDockSubscribe',
    permission: 'workspace',
    access: { kind: 'localOnly', targets: { party: 'party' } },
    params: WorkerDockSubscribe,
    handler: ({ party, includeRows }, { runtime, signal, connectionId }, emit) =>
      new Promise<void>((resolve) => {
        if (signal?.aborted) {
          resolve()
          return
        }
        const key = `worker-dock:${connectionId ?? 'local'}:${++sequence}`
        const close = () => runtime.cleanupSubscription(key)
        const db = runtime.getOrchestrationDb()
        const panes = new Set<string>()
        const stop = subscribeWorkerDock(
          db,
          party,
          emit,
          {
            refresh: () => refreshWorkerDockActivity(db, party, runtime, panes),
            subscribe: (wake) =>
              runtime.subscribeAgentStatusRowChanges((pane) => {
                if (panes.has(pane)) {
                  wake()
                }
              })
          },
          includeRows !== false
        )
        runtime.registerSubscriptionCleanup(
          key,
          () => {
            stop()
            signal?.removeEventListener('abort', close)
            resolve()
          },
          connectionId
        )
        signal?.addEventListener('abort', close, { once: true })
        if (signal?.aborted) {
          close()
        }
      })
  })
]
