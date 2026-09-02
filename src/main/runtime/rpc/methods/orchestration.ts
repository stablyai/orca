import type { RpcMethod } from '../core'
import { ORCHESTRATION_RUN_METHODS } from './orchestration-runs'
import { ORCHESTRATION_WORKER_METHODS } from './orchestration-worker-methods'
import { ORCHESTRATION_FEDERATION_METHODS } from './orchestration-federation-methods'
import { ORCHESTRATION_MUTATION_REQUEST_METHODS } from './orchestration-mutation-request-show'
import { ORCHESTRATION_SEND_METHODS } from './orchestration-send-methods'
import { ORCHESTRATION_CHECK_METHODS } from './orchestration-check-methods'
import { ORCHESTRATION_MESSAGE_METHODS } from './orchestration-message-methods'
import { ORCHESTRATION_DISPATCH_METHODS } from './orchestration-dispatch-methods'
import { ORCHESTRATION_ASK_METHODS } from './orchestration-ask-methods'
import { ORCHESTRATION_GATE_METHODS } from './orchestration-gates'
import { ORCHESTRATION_RESET_METHODS } from './orchestration-reset-methods'

export const ORCHESTRATION_METHODS: RpcMethod[] = [
  ...ORCHESTRATION_RUN_METHODS,
  ...ORCHESTRATION_WORKER_METHODS,
  ...ORCHESTRATION_FEDERATION_METHODS,
  ...ORCHESTRATION_MUTATION_REQUEST_METHODS,
  ...ORCHESTRATION_SEND_METHODS,
  ...ORCHESTRATION_CHECK_METHODS,
  ...ORCHESTRATION_MESSAGE_METHODS,
  ...ORCHESTRATION_DISPATCH_METHODS,
  ...ORCHESTRATION_ASK_METHODS,
  ...ORCHESTRATION_GATE_METHODS,
  ...ORCHESTRATION_RESET_METHODS
]
