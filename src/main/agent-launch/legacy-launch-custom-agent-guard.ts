// U7: the legacy built-in worktree.create request path (a client-supplied
// startupAgent/createdWithAgent with NO host-atomic agentLaunch) is preserved for
// one release for BUILT-IN agents only. A remote (mobile/paired-web) client cannot
// have a custom identity host-resolved on that path, so a custom id there is
// rejected at the RPC handler. Trusted in-process callers (desktop, headless
// automation) bypass the handler and keep the legacy path with their custom
// agentId — this guard is scoped to authenticated remote clients. (The session-tabs
// legacy `agent`/`launchAgent` fields already reject custom ids at their schema.)

import type { AuthenticatedClientKind } from './agent-launch-boundary-contract'
import { isCustomTuiAgentId } from '../../shared/custom-tui-agent-identity'

/** Whether a legacy (non-agentLaunch) create/launch request must be rejected
 *  because a remote client named a custom agent id the host cannot resolve there. */
export function shouldRejectLegacyCustomAgentLaunch(args: {
  hasAgentLaunch: boolean
  requestClientKind: AuthenticatedClientKind
  requestedAgentId: string | undefined
}): boolean {
  return (
    !args.hasAgentLaunch &&
    args.requestClientKind !== undefined &&
    args.requestedAgentId !== undefined &&
    isCustomTuiAgentId(args.requestedAgentId)
  )
}
