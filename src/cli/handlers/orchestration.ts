import type { CommandHandler } from '../dispatch'
import { ORCHESTRATION_COLLABORATION_HANDLERS } from './orchestration/collaboration-handlers'
import { ORCHESTRATION_CHECK_HANDLER } from './orchestration/message-check-handler'
import {
  ORCHESTRATION_DISPATCH_HANDLER,
  ORCHESTRATION_DISPATCH_INSPECTION_HANDLERS
} from './orchestration/dispatch-handlers'
import { ORCHESTRATION_GATE_HANDLERS } from './orchestration/gate-handlers'
import { ORCHESTRATION_INBOX_HANDLERS } from './orchestration/message-inbox-handlers'
import { ORCHESTRATION_QUESTION_HANDLER } from './orchestration/question-handler'
import { ORCHESTRATION_REQUEST_SHOW_HANDLER } from './orchestration/mutation-request-show-handler'
import { ORCHESTRATION_RESET_HANDLER } from './orchestration/reset-handler'
import { ORCHESTRATION_RUN_HANDLERS } from './orchestration/run-handlers'
import { ORCHESTRATION_SEND_HANDLER } from './orchestration/message-send-handler'
import { ORCHESTRATION_TASK_HANDLERS } from './orchestration/task-handlers'
import { ORCHESTRATION_WORKER_LAUNCH_HANDLER } from './orchestration/worker-launch-handler'
import { ORCHESTRATION_WORKER_OBSERVATION_HANDLERS } from './orchestration/worker-observation-handlers'
import { ORCHESTRATION_WORKER_TERMINAL_HANDLERS } from './orchestration/worker-terminal-handlers'

export const ORCHESTRATION_HANDLERS: Record<string, CommandHandler> = {
  ...ORCHESTRATION_RUN_HANDLERS,
  ...ORCHESTRATION_SEND_HANDLER,
  ...ORCHESTRATION_CHECK_HANDLER,
  ...ORCHESTRATION_INBOX_HANDLERS,
  ...ORCHESTRATION_TASK_HANDLERS,
  ...ORCHESTRATION_WORKER_LAUNCH_HANDLER,
  ...ORCHESTRATION_WORKER_OBSERVATION_HANDLERS,
  ...ORCHESTRATION_WORKER_TERMINAL_HANDLERS,
  ...ORCHESTRATION_DISPATCH_HANDLER,
  ...ORCHESTRATION_QUESTION_HANDLER,
  ...ORCHESTRATION_DISPATCH_INSPECTION_HANDLERS,
  ...ORCHESTRATION_REQUEST_SHOW_HANDLER,
  ...ORCHESTRATION_GATE_HANDLERS,
  ...ORCHESTRATION_RESET_HANDLER,
  ...ORCHESTRATION_COLLABORATION_HANDLERS
}
