import { SESSION_LINK_METHODS } from './session-link-methods'
import { requiringOrcadFeature } from '../../startup/orcad-readiness'
import { ORCHESTRATION_CREW_METHODS } from './crew-methods'
import { ORCHESTRATION_RUN_METHODS } from './runs/runs'
import { ORCHESTRATION_WORKER_METHODS } from './worker/worker-methods'
import { ORCHESTRATION_FEDERATION_METHODS } from './federation/federation-methods'
import { ORCHESTRATION_MUTATION_REQUEST_METHODS } from './runs/mutation-request-show'
import { ORCHESTRATION_SEND_METHODS } from './messaging/send-methods'
import { ORCHESTRATION_CHECK_METHODS } from './messaging/check-methods'
import { ORCHESTRATION_MESSAGE_METHODS } from './messaging/message-methods'
import { ORCHESTRATION_DISPATCH_METHODS } from './runs/dispatch-methods'
import { ORCHESTRATION_ASK_METHODS } from './messaging/ask-methods'
import { ORCHESTRATION_GATE_METHODS } from './gates/gates'
import { ORCHESTRATION_RESET_METHODS } from './runs/reset-methods'
import { ORCHESTRATION_CALLER_METHODS } from './caller-show'
import type { OrchestrationMethodAccessDeclaration } from './access/orchestration-method-access'

// Every orchestration method reads the authority restored at startup.
export const ORCHESTRATION_METHODS = requiringOrcadFeature('orchestration', [
  ...ORCHESTRATION_CREW_METHODS,
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
  ...ORCHESTRATION_RESET_METHODS,
  ...ORCHESTRATION_CALLER_METHODS,
  ...SESSION_LINK_METHODS
] satisfies readonly { readonly orchestrationAccess: OrchestrationMethodAccessDeclaration }[])
