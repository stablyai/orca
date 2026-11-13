import { TERMINAL_LIFECYCLE_METHODS } from './terminal-lifecycle-methods'
import { TERMINAL_MULTIPLEX_METHODS } from './terminal-multiplex-method'
import { TERMINAL_QUERY_METHODS } from './terminal-query-methods'
import { TERMINAL_SEND_METHODS } from './terminal-send-method'
import { TERMINAL_MODEL_CONTROL_METHODS } from './terminal-model-control-method'
import { TERMINAL_CLAUDE_AGENT_VIEW_METHODS } from './terminal-claude-agent-view-method'
import { TERMINAL_CODEX_QUESTION_SKIP_METHODS } from './terminal-codex-question-skip-method'
import { TERMINAL_SUBSCRIBE_METHODS } from './terminal-subscribe-method'
import {
  TERMINAL_VIEWPORT_METHODS_AFTER_STREAMS,
  TERMINAL_VIEWPORT_METHODS_BEFORE_STREAMS
} from './terminal-viewport-methods'
import { TERMINAL_VIEWER_COLORS_METHODS } from './terminal-viewer-colors-method'

// Preserve released manifest order; keep registration composition owned by this public entry point.
export const TERMINAL_METHODS = [
  ...TERMINAL_QUERY_METHODS,
  ...TERMINAL_SEND_METHODS,
  ...TERMINAL_LIFECYCLE_METHODS,
  ...TERMINAL_VIEWPORT_METHODS_BEFORE_STREAMS,
  ...TERMINAL_MULTIPLEX_METHODS,
  ...TERMINAL_SUBSCRIBE_METHODS,
  ...TERMINAL_VIEWPORT_METHODS_AFTER_STREAMS,
  ...TERMINAL_VIEWER_COLORS_METHODS,
  ...TERMINAL_CLAUDE_AGENT_VIEW_METHODS,
  ...TERMINAL_CODEX_QUESTION_SKIP_METHODS,
  ...TERMINAL_MODEL_CONTROL_METHODS
]
