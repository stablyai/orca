import type { OrchestrationSessionCaller } from '../../../../orchestration/orchestration-caller-identity'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import type { WorkerStartInput } from '../worker/worker-start-schema'
import type { WorkerStartMutation } from '../worker/worker-start-mutation'

export type FederatedWorkerStartRequest = {
  params: WorkerStartInput
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  /** Called only once preflight passes, so a refused start binds no new Run. */
  bindRunId: () => string
  task?: { id: string; spec: string; status: string }
  taskDeps: string[] | undefined
  orchestrationMutation?: WorkerStartMutation
  /** The coordinator's resolved session, when it is one; recorded as the Dispatch creator. */
  callerSession?: OrchestrationSessionCaller
}
