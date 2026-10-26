/** Paired launches move only the requesting connection's view.
 * Existing/folder targets select the tab; worktree creates provision setup/default tabs in the background.
 * In-process callers retain host navigation; folder creation activates nothing. */

import type { AgentLaunchTarget } from '../../../../shared/agent-launch-intent'
import type { AgentLaunchPublishedSurface } from '../../../agent-launch/agent-launch-executor'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { RpcContext } from '../core'

/** The paired client whose view this launch should move, or null when it moves the host's. */
export function agentLaunchCallerNavigationId(
  target: AgentLaunchTarget,
  context: Pick<RpcContext, 'caller'>
): string | null {
  return target.kind !== 'create-worktree' && context.caller?.kind === 'paired-device'
    ? context.caller.deviceId
    : null
}

/** Bookkeeping, never a gate: the agent already runs, so a failure here only leaves the view as it was. */
export function selectAgentLaunchTabForCaller(
  runtime: Pick<OrcaRuntimeService, 'selectCreatedMobileSessionTabForClient'>,
  surface: AgentLaunchPublishedSurface,
  clientNavigationId: string
): void {
  const { outcome } = surface
  // Found by pane or session, never by a predicted tab id.
  const selector =
    outcome.kind === 'terminal'
      ? outcome.paneKey
        ? parsePaneKey(outcome.paneKey)
        : null
      : { sessionId: outcome.sessionId }
  if (!selector) {
    return
  }
  try {
    if (
      !runtime.selectCreatedMobileSessionTabForClient(
        surface.worktreeId,
        selector,
        clientNavigationId
      )
    ) {
      console.warn('[agent-launch] the launch ran; its tab was not published to select')
    }
  } catch (error) {
    console.warn('[agent-launch] the launch ran; selecting its tab for the caller did not', error)
  }
}
