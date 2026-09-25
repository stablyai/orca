import {
  AGENT_LAUNCH_RUNTIME_CAPABILITY,
  AGENT_SESSION_BACKGROUND_TASK_CHILD_VIEWS_CAPABILITY,
  AGENT_SESSION_BACKGROUND_TASK_ROW_STOP_CAPABILITY,
  AGENT_SESSION_BACKGROUND_TASK_STOP_CAPABILITY,
  AGENT_SESSION_PENDING_SEND_RESULT_RUNTIME_CAPABILITY,
  AGENT_SESSION_TURN_ITEM_CAPABILITY,
  CLAUDE_STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
  type RuntimeCapability
} from '../../shared/protocol-version'

/**
 * What the desktop renderer advertises when it calls its own main process over `runtime:call`.
 *
 * Main and the renderer ship as one build, so nothing here is about version skew — the renderer
 * arrives as `clientKind: 'runtime'`, not in the `clientKind === undefined` population, so any
 * capability the host uses as an authorization gate has to be named here or the method is refused.
 * That is why this stays a curated set rather than the remote list: several remote-only entries
 * would change local behaviour if adopted (`SESSION_TAB_CLOSE_INTENT` alone would start refusing
 * an unattributed desktop tab close), and the divergence is pinned in this module's test.
 *
 * One constant, not one list per dispatch path: the unary and streaming handlers held separate
 * copies, and a capability added to one and missed on the other is invisible until a user hits it.
 */
export const DESKTOP_RENDERER_RUNTIME_CLIENT_CAPABILITIES: readonly RuntimeCapability[] = [
  AGENT_SESSION_BACKGROUND_TASK_STOP_CAPABILITY,
  AGENT_SESSION_PENDING_SEND_RESULT_RUNTIME_CAPABILITY,
  AGENT_SESSION_TURN_ITEM_CAPABILITY,
  AGENT_SESSION_BACKGROUND_TASK_ROW_STOP_CAPABILITY,
  AGENT_SESSION_BACKGROUND_TASK_CHILD_VIEWS_CAPABILITY,
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
  CLAUDE_STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
  // Without this `supportsAgentLaunch` refuses the renderer outright, while the same renderer
  // targeting a remote host is admitted — the asymmetry this constant exists to close.
  AGENT_LAUNCH_RUNTIME_CAPABILITY
] as const
