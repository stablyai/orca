import { TERMINAL_LIFECYCLE_METHODS } from './terminal/terminal-lifecycle-methods'
import { TERMINAL_MULTIPLEX_METHODS } from './terminal/terminal-multiplex-method'
import { TERMINAL_QUERY_METHODS } from './terminal/terminal-query-methods'
import { TERMINAL_SEND_METHODS } from './terminal/terminal-send-method'
import { TERMINAL_CLAUDE_AGENT_VIEW_METHODS } from './terminal/terminal-claude-agent-view-method'
import { TERMINAL_SUBSCRIBE_METHODS } from './terminal/terminal-subscribe-method'
import {
  TERMINAL_VIEWPORT_METHODS_AFTER_STREAMS,
  TERMINAL_VIEWPORT_METHODS_BEFORE_STREAMS
} from './terminal/terminal-viewport-methods'
import { TERMINAL_VIEWER_COLORS_METHODS } from './terminal/terminal-viewer-colors-method'

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
  ...TERMINAL_CLAUDE_AGENT_VIEW_METHODS
]
