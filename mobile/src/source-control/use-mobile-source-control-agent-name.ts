import { useEffect, useState } from 'react'
import type { SourceControlLaunchActionId } from '../../../src/shared/source-control-ai-actions'
import { tuiAgentDisplayName } from '../../../src/shared/tui-agent-display-names'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState } from '../transport/types'
import {
  hostRefusesOtherRuntimeWorkspace,
  loadMobileAgentLaunchContext
} from '../session/mobile-new-tab-agent-loader'
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
  const [resolved, setResolved] = useState<{ key: string; name: string | null } | null>(null)
  const refusesOtherRuntime = hostRefusesOtherRuntimeWorkspace(hostCapabilities)
  const key = actionId ? `${worktreeId}\0${actionId}` : null

  useEffect(() => {
    if (!key || !actionId || !client || connState !== 'connected') {
      return
    }
    let active = true
    void loadMobileAgentLaunchContext({
      client,
      worktreeId,
      hostRefusesOtherRuntime: refusesOtherRuntime
    })
      .then((context) => {
        const agent = resolveMobileSourceControlLaunchAgent(context, actionId)
        if (active) {
          setResolved({
            key,
            name: agent.kind === 'agent' ? tuiAgentDisplayName(agent.agent) : null
          })
        }
      })
      // The button still works without a name; the launch reports its own failure.
      .catch(() => {})
    return () => {
      active = false
    }
  }, [actionId, client, connState, key, refusesOtherRuntime, worktreeId])

  return resolved && resolved.key === key ? resolved.name : null
}
