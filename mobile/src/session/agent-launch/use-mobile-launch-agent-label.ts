import type { SourceControlLaunchActionId } from '../../../../src/shared/source-control/ai/recipes/source-control-ai-actions'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import { mobileTuiAgentLabel } from '../../agents/mobile-tui-agents'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { useLocalSearchParams } from 'expo-router'
import { firstParam } from '../../navigation/route-param-reader'
import { agentLaunchContextOf, useMobileAgentLaunchQueries } from './mobile-agent-launch-queries'
import {
  hostOpensChatsWithoutCli,
  resolveMobileSourceControlLaunchAgent
} from '../../source-control/review/agent-launch/mobile-source-control-launch-agent'
import { useMobileRegisteredAgents } from '../native-chat/agent-session/use-mobile-registered-agent'

// The agent a Fix button would start, by the same resolution the launch uses, so it can say "Fix with Claude".
export function useMobileLaunchAgentLabel(args: {
  client: RpcClient | null
  worktreeId: string
  hostCapabilities: readonly string[]
  actionId: SourceControlLaunchActionId | null
  enabled: boolean
}): string | null {
  const t = useMobileTranslation()
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
  const registeredAgents = useMobileRegisteredAgents(
    client,
    enabled && hostOpensChatsWithoutCli(hostCapabilities)
  )
  if (!actionId || !context) {
    return null
  }
  // An unknown agent keeps the generic label; the launch itself reports the real failure.
  const agent = resolveMobileSourceControlLaunchAgent(context, actionId, {
    hostCapabilities,
    registeredAgents
  })
  return agent.kind === 'agent' ? mobileTuiAgentLabel(agent.agent, t) : null
}

// Labels sit in workspace routes, whose path names the paired host.
function useRouteHostId(): string {
  return firstParam(useLocalSearchParams<{ hostId?: string | string[] }>().hostId)
}
