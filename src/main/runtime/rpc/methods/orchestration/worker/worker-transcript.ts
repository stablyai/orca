import { LOCAL_EXECUTION_HOST_ID } from '../../../../../../shared/execution-host/execution-host'
import {
  ORCHESTRATION_WORKER_TRANSCRIPT_METHOD,
  type OrchestrationWorkerTranscript,
  type OrchestrationWorkerTranscriptResult
} from '../../../../../../shared/orchestration/workers/orchestration-worker-transcript'
import { WorkerTranscriptParams } from '../../../../../../shared/rpc-contract/orchestration/orchestration-params'
import type { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import {
  readWorkerResumeSession,
  resolveWorkerLineage
} from '../../../../orchestration/db/dispatch-context/worker-follow-up-lineage'
import { defineOrchestrationMethod } from '../access/orchestration-method-access'

/** The log of the conversation the worker's terminal last reported, when it ran on this computer. */
export function readWorkerTranscript(
  db: OrchestrationDb | null,
  dispatchId: string
): OrchestrationWorkerTranscript | null {
  const resource = db ? resolveWorkerLineage(db, dispatchId)?.resource : undefined
  const session = readWorkerResumeSession(resource)
  const path = session?.providerSession.transcriptPath
  // An SSH-captured path names a file on that host, which this one cannot read.
  return session && path && session.captureHostId === LOCAL_EXECUTION_HOST_ID
    ? { agent: session.agent, path }
    : null
}

export const ORCHESTRATION_WORKER_TRANSCRIPT_METHODS = [
  defineOrchestrationMethod({
    name: ORCHESTRATION_WORKER_TRANSCRIPT_METHOD,
    access: { kind: 'reads', targets: { dispatch: 'dispatch' } },
    permission: 'workspace',
    share: 'not-shared',
    params: WorkerTranscriptParams,
    // Read only: opening a worker whose terminal is gone shows what it did, never restarts it.
    handler: (params, { runtime }): OrchestrationWorkerTranscriptResult => ({
      transcript: readWorkerTranscript(runtime.getOrchestrationDb(), params.dispatch)
    })
  })
]
