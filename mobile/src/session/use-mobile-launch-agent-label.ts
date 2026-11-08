import type { SourceControlLaunchActionId } from '../../../src/shared/source-control/ai/recipes/source-control-ai-actions'
import type { RpcClient } from '../transport/rpc-client'
import { TUI_AGENT_DISPLAY_NAMES as MOBILE_TUI_AGENT_LABELS } from '../../../src/shared/agent-launch/catalog/tui-agent-display-names'
import { useLocalSearchParams } from 'expo-router'
import { firstParam } from '../navigation/route-param-reader'
import { agentLaunchContextOf, useMobileAgentLaunchQueries } from './mobile-agent-launch-queries'
import { resolveMobileSourceControlLaunchAgent } from './mobile-source-control-launch-agent'

// The agent a Fix button would start, by the same resolution the launch uses, so it can say "Fix with Claude".
export function useMobileLaunchAgentLabel(args: {
  client: RpcClient | null
  worktreeId: string
  hostCapabilities: readonly string[]
  actionId: SourceControlLaunchActionId | null
  enabled: boolean
}): string | null {
  const { client, worktreeId, hostCapabilities, actionId, enabled } = args
  const context = agentLaunchContextOf(
    useMobileAgentLaunchQueries({
      hostId: useRouteHostId(),
      client,
      worktreeId,
      hostCapabilities,
      enabled
    })
  )
  if (!actionId || !context) {
    return null
  }
  // An unknown agent keeps the generic label; the launch itself reports the real failure.
  const agent = resolveMobileSourceControlLaunchAgent(context, actionId)
  return agent.kind === 'agent' ? MOBILE_TUI_AGENT_LABELS[agent.agent] : null
}

// Labels sit in workspace routes, whose path names the paired host.
function useRouteHostId(): string {
  return firstParam(useLocalSearchParams<{ hostId?: string | string[] }>().hostId)
}
