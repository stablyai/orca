import type { SourceControlLaunchActionId } from '../../../../src/shared/source-control/ai/recipes/source-control-ai-actions'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import type { ConnectionState } from '../../transport/connection/connection-state'
import { useMobileLaunchAgentLabel } from '../../session/agent-launch/use-mobile-launch-agent-label'

/**
 * Names the agent an AI action in this workspace would launch, so the button can say "Fix with Claude".
 * Null until known, or when none is available; the caller then says "AI".
 */
export function useMobileSourceControlAgentName(args: {
  client: RpcClient | null
  connState: ConnectionState
  worktreeId: string
  hostCapabilities: readonly string[]
  actionId: SourceControlLaunchActionId | null
}): string | null {
  const { connState, ...label } = args
  return useMobileLaunchAgentLabel({
    ...label,
    enabled: args.actionId !== null && connState === 'connected'
  })
}
