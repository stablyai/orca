import type { OrcaRuntimeService } from '../../../../orca-runtime'
import { defineMethod } from '../../../core'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import type { WorkerTerminalReleaseRuntime } from '../../../../orchestration/worker-terminal-release-runtime'
import type { FederatedDispatchRow } from '../../../../orchestration/types'
import { keptOpenStopRefusal } from '../../../../orchestration/db/worker-terminal/worker-terminal-user-keep'
import { callFederatedWorkerShow } from './worker-observation'
import { resolveStructuredWorkerIdentityForSession } from '../../../../structured-worker-authority'
import {
  OrchestrationWorkerKeepOpenParams,
  OrchestrationWorkerSubjectParams
} from '../../../../../../shared/rpc-contract/orchestration-worker-release-params'

export const ORCHESTRATION_WORKER_KEEP_OPEN_METHODS = [
  defineMethod({
    name: 'orchestration.workerAutoClose',
    permission: 'workspace',
    params: OrchestrationWorkerSubjectParams,
    handler: (params, { runtime }) => {
      const paneKey = resolveWorkerPaneKey(runtime, params)
      return {
        autoClose: paneKey ? runtime.getOrchestrationDb().getWorkerAutoCloseState(paneKey) : null
      }
    }
  }),
  defineMethod({
    name: 'orchestration.workerKeepOpen',
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
  defineMethod({
    name: 'orchestration.workerTerminalUserInput',
    permission: 'workspace',
    params: OrchestrationWorkerSubjectParams,
    // Older clients still report typing; only Keep open keeps a worker now, so this records nothing.
    handler: () => ({ changed: 0 })
  }),
  defineMethod({
    name: 'orchestration.workerChatTouch',
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
