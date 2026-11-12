import type { OrcaRuntimeService } from '../../../../orca-runtime'
import { defineOrchestrationMethod } from '../access/orchestration-method-access'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import type { WorkerTerminalReleaseRuntime } from '../../../../orchestration/terminal-authority/release/worker-terminal-release-runtime'
import type { FederatedDispatchRow } from '../../../../orchestration/db/orchestration-records'
import { keptOpenStopRefusal } from '../../../../orchestration/db/worker-terminal/worker-terminal-user-keep'
import { callFederatedWorkerShow } from './worker-observation'
import { resolveStructuredWorkerIdentityForSession } from '../../../../orchestration/terminal-authority/structured-sessions/structured-worker-authority'
import {
  OrchestrationWorkerKeepOpenParams,
  OrchestrationWorkerSubjectParams
} from '../../../../../../shared/rpc-contract/orchestration-worker-release-params'

export const ORCHESTRATION_WORKER_KEEP_OPEN_METHODS = [
  defineOrchestrationMethod({
    name: 'orchestration.workerAutoClose',
    access: {
      kind: 'reads',
      targets: { paneKey: 'worker', sessionId: 'worker', terminal: 'worker' }
    },
    permission: 'workspace',
    params: OrchestrationWorkerSubjectParams,
    handler: (params, { runtime }) => {
      const paneKey = resolveWorkerPaneKey(runtime, params)
      return {
        autoClose: paneKey ? runtime.getOrchestrationDb().getWorkerAutoCloseState(paneKey) : null
      }
    }
  }),
  defineOrchestrationMethod({
    name: 'orchestration.workerKeepOpen',
    access: {
      kind: 'writes',
      targets: { paneKey: 'worker', sessionId: 'worker', terminal: 'worker' }
    },
    permission: 'workspace',
    params: OrchestrationWorkerKeepOpenParams,
    handler: (params, { runtime }) => {
      const paneKey = resolveWorkerPaneKey(runtime, params)
      if (!paneKey) {
        return { autoClose: null }
      }
      const db = runtime.getOrchestrationDb()
      if (params.keep) {
        db.keepWorkerTerminalOpen(paneKey)
      } else {
        db.allowWorkerTerminalAutoClose(paneKey, (resource) =>
          runtime.isWorkerAgentInTurn(resource) ? null : Date.now()
        )
      }
      return { autoClose: db.getWorkerAutoCloseState(paneKey) }
    }
  }),
  defineOrchestrationMethod({
    name: 'orchestration.workerTerminalUserInput',
    access: {
      kind: 'writes',
      targets: { paneKey: 'worker', sessionId: 'worker', terminal: 'worker' }
    },
    permission: 'workspace',
    params: OrchestrationWorkerSubjectParams,
    // Older clients still report typing; only Keep open keeps a worker now, so this records nothing.
    handler: () => ({ changed: 0 })
  }),
  defineOrchestrationMethod({
    name: 'orchestration.workerChatTouch',
    access: {
      kind: 'writes',
      targets: { paneKey: 'worker', sessionId: 'worker', terminal: 'worker' }
    },
    permission: 'workspace',
    params: OrchestrationWorkerSubjectParams,
    // Older clients still report viewing; answered like typing, without `pending`, so they stop retrying.
    handler: () => ({ changed: 0 })
  })
]

// Structured workers are named by session; their pane key is a credential the owning runtime resolves.
function resolveWorkerPaneKey(
  runtime: OrcaRuntimeService,
  params: { paneKey?: string; sessionId?: string; terminal?: string }
): string | null | undefined {
  if (params.sessionId) {
    // Durable identity, not live authority: a closing chat's tab must still be keepable.
    return resolveStructuredWorkerIdentityForSession(params.sessionId, runtime.getOrchestrationDb())
      ?.paneKey
  }
  return params.paneKey ?? (params.terminal ? runtime.getTerminalPaneKey(params.terminal) : null)
}

/** Stop changes this side before the worker's host can refuse a kept worker, so the host is asked first;
 *  without an answer nothing is stopped. Hosts that predate Keep open answer without `keptOpen`. */
export async function refuseFederatedStopWhileKeptOpen(
  runtime: WorkerTerminalReleaseRuntime,
  federated: FederatedDispatchRow
): Promise<void> {
  const shown = await callFederatedWorkerShow(runtime, federated).catch((error: unknown) => {
    if (error instanceof OrchestrationError) {
      throw error
    }
    throw new OrchestrationError(
      'remote_runtime_unavailable',
      `Could not check whether the user kept Dispatch ${federated.dispatch_id} open on ${federated.environment_name}, so it was not stopped. Retry worker-stop. (${error instanceof Error ? error.message : String(error)})`
    )
  })
  if (shown.keptOpen === true) {
    throw keptOpenStopRefusal(federated.dispatch_id)
  }
}
