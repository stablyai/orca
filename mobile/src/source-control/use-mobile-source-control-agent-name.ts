import type { SourceControlLaunchActionId } from '../../../src/shared/source-control/ai/recipes/source-control-ai-actions'
import { tuiAgentDisplayName } from '../../../src/shared/agent-launch/catalog/tui-agent-display-names'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState } from '../transport/types'
import {
  agentLaunchContextOf,
  useMobileAgentLaunchQueries
} from '../session/mobile-agent-launch-queries'
import { useRouteHostId } from '../session/use-mobile-launch-agent-label'
import { resolveMobileSourceControlLaunchAgent } from '../session/mobile-source-control-launch-agent'

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
  const { client, connState, worktreeId, hostCapabilities, actionId } = args
  const context = agentLaunchContextOf(
    useMobileAgentLaunchQueries({
      hostId: useRouteHostId(),
      client,
      worktreeId,
      hostCapabilities,
      enabled: actionId !== null && connState === 'connected'
    })
  )
  if (!actionId || !context) {
    return null
  }
  // The button still works without a name; the launch reports its own failure.
  const agent = resolveMobileSourceControlLaunchAgent(context, actionId)
  return agent.kind === 'agent' ? tuiAgentDisplayName(agent.agent) : null
}
