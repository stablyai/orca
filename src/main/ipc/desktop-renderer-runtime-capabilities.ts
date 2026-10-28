import {
  REPO_SEARCH_QUALIFIED_REFS_RUNTIME_CAPABILITY,
  type RuntimeCapability
} from '../../shared/protocol-version'
import { STRUCTURED_AGENT_SESSION_RENDERER_CLIENT_CAPABILITIES } from '../../shared/structured-agent-session-renderer-client-capabilities'
import {
  AGENT_LAUNCH_PROMPT_UNCONFIRMED_RUNTIME_CAPABILITY,
  AGENT_LAUNCH_RUNTIME_CAPABILITY,
  AGENT_LAUNCH_TAB_CLOSED_CLIENT_CAPABILITY
} from '../../shared/agent-launch-runtime-capability'
import {
  TERMINAL_QUICK_COMMAND_LARGE_LISTS_RUNTIME_CAPABILITY,
  TERMINAL_QUICK_COMMAND_LONG_PROMPTS_RUNTIME_CAPABILITY
} from '../../shared/terminal-quick-command-capabilities'

/** Curate one capability set for unary/streaming desktop calls; remote-only gates can alter local semantics even on the same build. */
export const DESKTOP_RENDERER_RUNTIME_CLIENT_CAPABILITIES: readonly RuntimeCapability[] = [
  ...STRUCTURED_AGENT_SESSION_RENDERER_CLIENT_CAPABILITIES,
  REPO_SEARCH_QUALIFIED_REFS_RUNTIME_CAPABILITY,
  // Agent-launch authorization requires this even for the same-build desktop renderer.
  AGENT_LAUNCH_RUNTIME_CAPABILITY,
  // Read unconfirmed prompt replays after interrupted delivery.
  AGENT_LAUNCH_PROMPT_UNCONFIRMED_RUNTIME_CAPABILITY,
  // Treat closed launch tabs as silent cancellation instead of unknown failure.
  AGENT_LAUNCH_TAB_CLOSED_CLIENT_CAPABILITY,
  TERMINAL_QUICK_COMMAND_LONG_PROMPTS_RUNTIME_CAPABILITY,
  TERMINAL_QUICK_COMMAND_LARGE_LISTS_RUNTIME_CAPABILITY
] as const
