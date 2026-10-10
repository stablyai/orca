// Listing restart offers on a process that never built its structured host.
//
// Building the host opens the record store and journal, so a paired desktop asking every server it
// connects to would open them on servers that never ran a chat. The offers live only in the
// recovery capsule, so a capsule holding nothing at all answers "nothing to resume" by itself.

import { AgentSessionRecoveryCapsule } from '../../agent-session-recovery-capsule'
import { getProfileUserDataPath } from '../../../orca-profiles/profile-storage-paths'
import { getStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'

export type RestartOfferReadShortcutDeps = {
  hostInstalled: () => boolean
  recordsHeld: () => Promise<boolean>
}

const defaultDeps: RestartOfferReadShortcutDeps = {
  hostInstalled: () => getStructuredAgentSessionHost() !== null,
  // The host's own state directory (orca-runtime-get-worktree-ps.ts `stateDirectory`).
  recordsHeld: () => new AgentSessionRecoveryCapsule(getProfileUserDataPath()).holdsAnyRecord()
}

/** True only when no host exists and the capsule provably holds nothing; otherwise the caller
 *  builds the host and lists as it always has. */
export async function restartOffersProvablyEmpty(
  deps: RestartOfferReadShortcutDeps = defaultDeps
): Promise<boolean> {
  if (deps.hostInstalled()) {
    return false
  }
  try {
    return !(await deps.recordsHeld())
  } catch {
    return false
  }
}
