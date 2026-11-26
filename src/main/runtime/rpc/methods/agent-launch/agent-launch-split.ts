/** `agent launch --split`: refused before anything runs unless this window can place the chat. */

import type {
  AgentLaunchPlacementReceipt,
  AgentLaunchResult
} from '../../../../../shared/agent-launch/contracts/agent-launch-intent'
import type { AgentLaunchParams } from '../../../../../shared/rpc-contract/agent-launch/agent-launch-params'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../../shared/workspace-layout/layout-owner-switch'
import type { RpcContext } from '../../core'
import type { AgentLaunchView } from './agent-launch-tab-publication'

export const AGENT_LAUNCH_SPLIT_UNSUPPORTED_CODE = 'agent_launch_split_unsupported'

/** A paired device must not rearrange the host's screen; a windowless host or a terminal has no chat
 *  pane to place. Retries included: a retry needs the window back, or a launch without --split. */
export function assertAgentLaunchSplitAdmissible(
  params: Pick<AgentLaunchParams, 'placement' | 'surface'>,
  context: Pick<RpcContext, 'caller' | 'runtime'>
): void {
  if (
    params.placement?.split &&
    (context.caller?.kind === 'paired-device' ||
      params.surface !== 'chat' ||
      ORCA_LAYOUT_OWNER_IS_MAIN ||
      !context.runtime.canPublishAgentLaunchTab())
  ) {
    throw new Error(AGENT_LAUNCH_SPLIT_UNSUPPORTED_CODE)
  }
}

/** Starts placing an admitted launch's new chat; no placement when the window never answered. */
export function placeLaunchedChat(
  runtime: Pick<RpcContext['runtime'], 'placeAgentLaunchSplit'>,
  surface: AgentLaunchResult,
  { split, presentation }: AgentLaunchView
): Promise<{ placement?: AgentLaunchPlacementReceipt }> | undefined {
  if (!split) {
    return undefined
  }
  const placing =
    surface.outcome.kind === 'structured'
      ? runtime.placeAgentLaunchSplit({
          worktreeId: surface.worktreeId,
          sessionId: surface.outcome.sessionId,
          split,
          activate: presentation === 'focused',
          expiresAt: Date.now() + 10_000
        })
      : null
  // A chat that fell back to a terminal opens as a tab; a lost answer never fails the launch.
  return (placing ?? Promise.resolve({ groupId: '', fallback: 'not-split' as const })).then(
    (placement) => ({ placement }),
    () => ({})
  )
}
