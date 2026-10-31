import { AGENT_LAUNCH_RUNTIME_CAPABILITY } from '../../shared/agent-launch-runtime-capability'
import { WORKTREE_BACKGROUND_REMOVAL_RUNTIME_CAPABILITY } from '../../shared/worktree-runtime-capabilities'

// Paired CLI callers are not exempt from the host's agent.launch gate like the local socket is.
// Advertising background removal makes `worktree rm` wait out the delete and report its real
// outcome instead of an acceptance reply (#35135); pending-removal rows stop being hidden too.
export const CLI_CLIENT_CAPABILITIES = [
  AGENT_LAUNCH_RUNTIME_CAPABILITY,
  WORKTREE_BACKGROUND_REMOVAL_RUNTIME_CAPABILITY
] as const
