import type { RpcContext } from '../core'
import { supportsStructuredAgentSessions } from './structured-agent-session-policy'

/** Republishes structured tabs into the host's own snapshot map.
 *
 *  Mobile restores regardless of its capability: an old build is shown a fallback prompt in place
 *  of each chat, and gating on capability left it with nothing to project after a desktop restart —
 *  no chat and no prompt. Restoring spawns no provider child for a cleanly closed session, and a
 *  host with no saved sessions returns before building anything. */
export function restoreStructuredTabsIfSupported(
  context: Pick<RpcContext, 'runtime' | 'clientKind' | 'clientCapabilities'>
): Promise<void> | undefined {
  const shouldRestore = context.clientKind === 'mobile' || supportsStructuredAgentSessions(context)
  if (shouldRestore && typeof context.runtime.restoreStructuredAgentSessionTabs === 'function') {
    return context.runtime.restoreStructuredAgentSessionTabs()
  }
  // Nothing to restore: callers skip the await, so a stream's setup keeps its timing.
  return undefined
}
