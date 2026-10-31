import type { RpcContext } from '../core'
import { supportsStructuredAgentSessions } from './structured-agent-session-policy'

/** Prepare record-only tabs even for legacy mobile fallback rows; capability gating would leave neither chat nor prompt after restart.
 * No journal is opened, and an empty saved inventory never builds the host. */
export function prepareStructuredTabsIfSupported(
  context: Pick<RpcContext, 'runtime' | 'clientKind' | 'clientCapabilities'>
): Promise<void> | undefined {
  const shouldRestore = context.clientKind === 'mobile' || supportsStructuredAgentSessions(context)
  if (shouldRestore && typeof context.runtime.restoreStructuredAgentSessionTabs === 'function') {
    return context.runtime.restoreStructuredAgentSessionTabs()
  }
  // Nothing to restore: callers skip the await, so a stream's setup keeps its timing.
  return undefined
}
