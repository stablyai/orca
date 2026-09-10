import type { RpcContext } from '../core'
import {
  isStructuredNativeChatEnabled,
  supportsStructuredAgentSessions
} from './structured-agent-session-policy'

/** Republishes structured tabs into the host's own snapshot map.
 *
 *  Mobile is gated on the host setting alone, NOT on the client's capability: an old build is
 *  shown a fallback prompt in place of each chat, and gating on capability left it with nothing to
 *  project after a desktop restart — no chat and no prompt. The setting still gates it, because
 *  with structured chat off there is nothing for any mobile client to reach. Restoring spawns no
 *  provider child for a cleanly closed session. */
export async function restoreStructuredTabsIfSupported(
  context: Pick<RpcContext, 'runtime' | 'clientKind' | 'clientCapabilities'>
): Promise<void> {
  const shouldRestore =
    context.clientKind === 'mobile'
      ? isStructuredNativeChatEnabled(context.runtime)
      : supportsStructuredAgentSessions(context)
  if (shouldRestore && typeof context.runtime.restoreStructuredAgentSessionTabs === 'function') {
    await context.runtime.restoreStructuredAgentSessionTabs()
  }
}
