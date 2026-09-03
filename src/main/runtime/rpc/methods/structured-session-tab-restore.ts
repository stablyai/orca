import type { RpcContext } from '../core'
import { supportsStructuredAgentSessions } from './structured-agent-session-policy'

export async function restoreStructuredTabsIfSupported(
  context: Pick<RpcContext, 'runtime' | 'clientKind' | 'clientCapabilities'>
): Promise<void> {
  if (
    supportsStructuredAgentSessions(context) &&
    typeof context.runtime.restoreStructuredAgentSessionTabs === 'function'
  ) {
    await context.runtime.restoreStructuredAgentSessionTabs()
  }
}
