import type { RpcMethod } from '../core'
import { ORCHESTRATION_WORKER_CONTROL_METHODS } from './orchestration-worker-control'
import { ORCHESTRATION_WORKER_RELEASE_METHODS } from './orchestration-worker-release'
import { ORCHESTRATION_WORKER_STOP_METHODS } from './orchestration-worker-stop'
import { ORCHESTRATION_WORKER_START_METHODS } from './orchestration-workers'
import { ORCHESTRATION_WORKER_AUTHORITY_POLICY_METHODS } from './orchestration-worker-authority-policy'

export const ORCHESTRATION_WORKER_METHODS: RpcMethod[] = [
  ...ORCHESTRATION_WORKER_AUTHORITY_POLICY_METHODS,
  ...ORCHESTRATION_WORKER_START_METHODS,
  ...ORCHESTRATION_WORKER_CONTROL_METHODS,
  ...ORCHESTRATION_WORKER_STOP_METHODS,
  ...ORCHESTRATION_WORKER_RELEASE_METHODS
]
