// Where a supervised worker's start and stop stand, as its worker_dispatches row records it.
export type WorkerDispatchState =
  | 'starting'
  | 'ready'
  | 'start_unknown'
  | 'failed'
  | 'succeeded'
  | 'stopping'
  | 'stop_unknown'
  | 'stopped'
  | 'abandoned'
