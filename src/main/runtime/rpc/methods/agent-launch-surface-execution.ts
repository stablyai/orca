import type { AgentLaunchResult } from '../../../../shared/agent-launch-intent'
import { executeAgentLaunch } from '../../../agent-launch/agent-launch-executor'
import type { RpcContext } from '../core'
import type { ReplaySafeLaunch } from './agent-launch-replay'
import {
  agentLaunchCallerNavigationId,
  selectAgentLaunchTabForCaller
} from './agent-launch-caller-selection'
import { agentLaunchSurfaceFactory } from './agent-launch-surfaces'
import { agentLaunchWorkspaceFactory } from './agent-launch-worktree-creation'
import type { resolveUnlaunchedIntent } from './agent-launch-intent-resolution'
import { withPlacement, type AgentLaunchView } from './agent-launch-tab-publication'

export type HostLaunchContext = RpcContext & {
  agentLaunchPolicy?: { onSurfacePublished?: (surface: AgentLaunchResult) => void }
}

export async function runAgentLaunch(
  { intent, decidedMode }: Awaited<ReturnType<typeof resolveUnlaunchedIntent>>,
  context: HostLaunchContext,
  view: AgentLaunchView,
  replaySafe?: ReplaySafeLaunch
): Promise<AgentLaunchResult> {
  const callerNavigationId = agentLaunchCallerNavigationId(intent.target, context)
  const result = await executeAgentLaunch({
    runtime: context.runtime,
    intent,
    decidedMode,
    surfaces: agentLaunchSurfaceFactory(
      context,
      replaySafe?.attachOperationId,
      replaySafe?.callerKey,
      callerNavigationId !== null,
      replaySafe?.terminalSpawn,
      view
    ),
    workspaces: agentLaunchWorkspaceFactory(context, intent.agent),
    // The tab is shown as it is published, not after a prompt that can take a minute to land.
    onSurfacePublished: (surface) => {
      try {
        context.agentLaunchPolicy?.onSurfacePublished?.(surface)
      } catch (error) {
        console.warn('[agent-launch] publication bookkeeping failed', error)
      }
      view.early?.surfacePublished(surface)
      replaySafe?.recordSurface(withPlacement(surface, view))
      if (callerNavigationId !== null && view.presentation !== 'background') {
        selectAgentLaunchTabForCaller(context.runtime, surface, callerNavigationId)
      }
    }
  })
  return withPlacement(result, view)
}
