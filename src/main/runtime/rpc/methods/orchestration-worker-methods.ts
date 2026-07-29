import type { RpcMethod } from '../core'
import { ORCHESTRATION_WORKER_CONTROL_METHODS } from './orchestration-worker-control'
import { ORCHESTRATION_WORKER_STOP_METHODS } from './orchestration-worker-stop'
import { ORCHESTRATION_WORKER_START_METHODS } from './orchestration-workers'

export const ORCHESTRATION_WORKER_METHODS: RpcMethod[] = [
  ...ORCHESTRATION_WORKER_START_METHODS,
  ...ORCHESTRATION_WORKER_CONTROL_METHODS,
  ...ORCHESTRATION_WORKER_STOP_METHODS
]
