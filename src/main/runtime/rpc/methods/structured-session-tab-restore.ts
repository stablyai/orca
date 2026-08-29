import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import type { RpcContext } from '../core'

export async function restoreStructuredTabsIfSupported(
  runtime: RpcContext['runtime'],
  capabilities: readonly string[] | undefined
): Promise<void> {
  if (capabilities?.includes(STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY)) {
    await runtime.restoreStructuredAgentSessionTabs()
  }
}
