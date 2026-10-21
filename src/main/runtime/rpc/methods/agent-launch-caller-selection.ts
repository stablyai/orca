/**
 * Which view a launch moves: the requesting connection's, never the host's or another client's.
 *
 * A paired client (a phone, or a desktop client of a remote server) that launches into an existing
 * workspace, or into a folder workspace it creates, gets the new tab as its own selection, recorded
 * the way `session.tabs.createTerminal` selects the tab it creates for its caller. In-process
 * callers keep today's behaviour, and their launch that creates a worktree keeps
 * `worktree.create`'s navigation. A paired client's worktree create never activates the host
 * window: its setup and default tabs are provisioned in the background. A folder workspace has
 * neither, and its create activates nothing, so it is selected for its caller like an existing one.
 */

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
