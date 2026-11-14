import type { CommandHandler } from '../dispatch/dispatch'
import { ORCHESTRATION_CHECK_HANDLER } from './messages/message-check-handler'
import {
  ORCHESTRATION_DISPATCH_HANDLER,
  ORCHESTRATION_DISPATCH_INSPECTION_HANDLERS
} from './dispatches/dispatch-handlers'
import { ORCHESTRATION_GATE_HANDLERS } from './gates/gate-handlers'
import { ORCHESTRATION_INBOX_HANDLERS } from './messages/message-inbox-handlers'
import { ORCHESTRATION_QUESTION_HANDLER } from './messages/question-handler'
import { ORCHESTRATION_REQUEST_SHOW_HANDLER } from './recovery/mutation-request-show-handler'
import { ORCHESTRATION_RESET_HANDLER } from './runs/reset-handler'
import { ORCHESTRATION_RUN_HANDLERS } from './runs/run-handlers'
import { ORCHESTRATION_SEND_HANDLER } from './messages/message-send-handler'
import { ORCHESTRATION_TASK_HANDLERS } from './tasks/task-handlers'
import { ORCHESTRATION_WORKER_LAUNCH_HANDLER } from './workers/worker-launch-handler'
import { ORCHESTRATION_WORKER_OBSERVATION_HANDLERS } from './workers/worker-observation-handlers'
import { ORCHESTRATION_WORKER_TERMINAL_HANDLERS } from './workers/worker-terminal-handlers'

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
  ...ORCHESTRATION_RESET_HANDLER
}
