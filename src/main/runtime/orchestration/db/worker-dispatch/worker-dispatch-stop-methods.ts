import type {
  beginWorkerStop,
  isDispatchProcessCurrent,
  isWorkerStopRequested,
  listHelperDispatchIds,
  markWorkerStopUnknown,
  reconcileFederatedWorkerStop,
  resumeFederatedWorkerForTerminalRelay,
  settleWorkerStop
} from './worker-dispatch-stop'

export type WorkerDispatchStopMethods = {
  isDispatchProcessCurrent: typeof isDispatchProcessCurrent
  isWorkerStopRequested: typeof isWorkerStopRequested
  listHelperDispatchIds: typeof listHelperDispatchIds
  beginWorkerStop: typeof beginWorkerStop
  settleWorkerStop: typeof settleWorkerStop
  reconcileFederatedWorkerStop: typeof reconcileFederatedWorkerStop
  resumeFederatedWorkerForTerminalRelay: typeof resumeFederatedWorkerForTerminalRelay
  markWorkerStopUnknown: typeof markWorkerStopUnknown
}
