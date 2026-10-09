import {
  AGENT_SESSION_ACCEPTED_SEND_RUNTIME_CAPABILITY,
  AGENT_SESSION_BACKGROUND_TASK_ROW_STOP_CAPABILITY,
  AGENT_SESSION_BACKGROUND_TASK_STOP_CAPABILITY,
  AGENT_SESSION_PENDING_SEND_RESULT_RUNTIME_CAPABILITY,
  AGENT_SESSION_TURN_ITEM_CAPABILITY,
  CLAUDE_STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
  PI_STRUCTURED_DIALOGS_RUNTIME_CAPABILITY,
  REPO_SEARCH_QUALIFIED_REFS_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_CLIENT_LAUNCH_MODE_CAPABILITY,
  STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
  type RuntimeCapability
} from '../../shared/protocol-version'
import {
  AGENT_LAUNCH_PROMPT_UNCONFIRMED_RUNTIME_CAPABILITY,
  AGENT_LAUNCH_RUNTIME_CAPABILITY,
  AGENT_LAUNCH_TAB_CLOSED_CLIENT_CAPABILITY
} from '../../shared/agent-launch-runtime-capability'
import { AGENT_SESSION_BACKGROUND_TASK_CHILD_VIEWS_CAPABILITY } from '../../shared/agent-session-background-task-child-views-capability'

/**
 * What the desktop renderer advertises when it calls its own main process over `runtime:call`.
 *
 * Main and the renderer ship as one build, so nothing here is about version skew — the renderer
 * arrives as `clientKind: 'runtime'`, not in the `clientKind === undefined` population, so any
 * capability the host uses as an authorization gate has to be named here or the method is refused.
 * That is why this stays a curated set rather than the remote list: several remote-only entries
 * would change local behaviour if adopted (`SESSION_TAB_CLOSE_INTENT` alone would start refusing
 * an unattributed desktop tab close), the lists remain curated for those reasons.
 *
 * One constant, not one list per dispatch path: the unary and streaming handlers held separate
 * copies, and a capability added to one and missed on the other is invisible until a user hits it.
 */
export const DESKTOP_RENDERER_RUNTIME_CLIENT_CAPABILITIES: readonly RuntimeCapability[] = [
  AGENT_SESSION_BACKGROUND_TASK_STOP_CAPABILITY,
  AGENT_SESSION_PENDING_SEND_RESULT_RUNTIME_CAPABILITY,
  AGENT_SESSION_ACCEPTED_SEND_RUNTIME_CAPABILITY,
  AGENT_SESSION_TURN_ITEM_CAPABILITY,
  AGENT_SESSION_BACKGROUND_TASK_ROW_STOP_CAPABILITY,
  AGENT_SESSION_BACKGROUND_TASK_CHILD_VIEWS_CAPABILITY,
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
  CLAUDE_STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
  // The renderer reads `agentSession.agents` and renders a chat tab of any agent its host lists.
  STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY,
  PI_STRUCTURED_DIALOGS_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_CLIENT_LAUNCH_MODE_CAPABILITY,
  REPO_SEARCH_QUALIFIED_REFS_RUNTIME_CAPABILITY,
  // Without this `supportsAgentLaunch` refuses the renderer outright, while the same renderer
  // targeting a remote host is admitted — the asymmetry this constant exists to close.
  AGENT_LAUNCH_RUNTIME_CAPABILITY,
  // A replay after a restart mid-delivery answers the running agent with an `unconfirmed` prompt,
  // which the desktop reads, rather than refusing it as unknown.
  AGENT_LAUNCH_PROMPT_UNCONFIRMED_RUNTIME_CAPABILITY,
  // A launch whose tab the user closed is answered as exactly that, which the desktop stays silent
  // on, rather than as unknown, which it would report as a failure.
  AGENT_LAUNCH_TAB_CLOSED_CLIENT_CAPABILITY
] as const
