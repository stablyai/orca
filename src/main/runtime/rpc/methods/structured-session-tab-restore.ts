import type { RpcContext } from '../core'
import { canServeStructuredAgentSessions } from './structured-agent-session-policy'

/** Republishes structured tabs into the host's own snapshot map.
 *
 *  Every mobile client restores, capable or not: an old build is shown a fallback prompt in place
 *  of each chat, and gating on capability left it with nothing to project after a desktop restart —
 *  no chat and no prompt. The host's Chat UI setting is not asked: it governs new chats, and these
 *  already exist. Restoring opens the record store only when one is on disk, and spawns no provider
 *  child for a cleanly closed session. */
export async function restoreStructuredTabsIfSupported(
  context: Pick<RpcContext, 'runtime' | 'clientKind' | 'clientCapabilities'>
): Promise<void> {
  const shouldRestore = context.clientKind === 'mobile' || canServeStructuredAgentSessions(context)
  if (shouldRestore && typeof context.runtime.restoreStructuredAgentSessionTabs === 'function') {
    await context.runtime.restoreStructuredAgentSessionTabs()
  }
}
