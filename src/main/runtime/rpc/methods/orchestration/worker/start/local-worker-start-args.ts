import type { WorkerStartInput } from './worker-start-input'
import type { OrcaRuntimeService } from '../../../../../orca-runtime'
import type { OrchestrationDb } from '../../../../../orchestration/db/orchestration-db'
import type {
  RunRow,
  TaskRow,
  DispatchContextRow
} from '../../../../../orchestration/db/orchestration-records'
import type { OrchestrationEntryCaller } from '../../../../../orchestration/addressing/orchestration-caller-identity'
import type { OrchestrationPartyIdentity as OrchestrationCallerIdentity } from '../../../../../../../shared/orchestration/mailbox/orchestration-party-identity'
import type { AgentLaunchModeReceipt as WorkerStartModeReceipt } from '../../../../../../../shared/agent-launch/contracts/agent-launch-intent'
import type { WorkerStartMutation } from './worker-start-mutation'
import type { WorkerFollowUp } from '../follow-up/worker-follow-up-placement'
import type { SystemWorkerCoordinator } from '../system-worker-coordinator'

export type LocalWorkerStartArgs = {
  params: WorkerStartInput
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  /** Called only once effect-free validation passes, so a refused start binds no new Run. */
  bindRun: () => RunRow
  taskDeps: string[] | undefined
  coordinator: OrchestrationCallerIdentity | null
  callerSession?: OrchestrationEntryCaller
  existingTask?: TaskRow
  orchestrationMutation?: WorkerStartMutation
  mode: WorkerStartModeReceipt
  /** Stamped on the Dispatch so the workers this one starts start as chats too. */
  chatLineage?: boolean
  /** Set when a worker starts its own helper; the helper reports to this Dispatch. */
  helperCreator?: DispatchContextRow
  followUp?: WorkerFollowUp
  /** Runtime-owned coordinators have no agent terminal; this is never read from RPC params. */
  systemCoordinator?: SystemWorkerCoordinator
}
