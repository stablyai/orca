import { useEffect, useState } from 'react'
import type { SourceControlLaunchActionId } from '../../../src/shared/source-control-ai-actions'
import type { RpcClient } from '../transport/rpc-client'
import { MOBILE_TUI_AGENT_LABELS } from '../tasks/mobile-tui-agents'
import {
  hostRefusesOtherRuntimeWorkspace,
  loadMobileAgentLaunchContext
} from './mobile-new-tab-agent-loader'
import { resolveMobileSourceControlLaunchAgent } from './mobile-source-control-launch-agent'

// The agent a Fix button would start, by the same resolution the launch uses, so it can say "Fix with Claude".
export function useMobileLaunchAgentLabel(args: {
  client: RpcClient | null
  worktreeId: string
  hostCapabilities: readonly string[]
  actionId: SourceControlLaunchActionId
  enabled: boolean
}): string | null {
  const { client, worktreeId, hostCapabilities, actionId, enabled } = args
  const [resolved, setResolved] = useState<{ key: string; label: string | null } | null>(null)
  const key = `${worktreeId}\u0000${actionId}`
  const refusesOtherRuntime = hostRefusesOtherRuntimeWorkspace(hostCapabilities)
  useEffect(() => {
    if (!enabled || !client) {
      return
    }
    let cancelled = false
    void loadMobileAgentLaunchContext({
      client,
      worktreeId,
      hostRefusesOtherRuntime: refusesOtherRuntime
    })
      .then((context) => {
        const agent = resolveMobileSourceControlLaunchAgent(context, actionId)
        if (!cancelled) {
          setResolved({
            key,
            label: agent.kind === 'agent' ? MOBILE_TUI_AGENT_LABELS[agent.agent] : null
          })
        }
      })
      // An unknown agent keeps the generic label; the launch itself reports the real failure.
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [actionId, client, enabled, key, refusesOtherRuntime, worktreeId])
  return resolved?.key === key ? resolved.label : null
}
