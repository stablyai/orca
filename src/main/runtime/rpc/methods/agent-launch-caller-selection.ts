/**
 * Which view a launch moves: the requesting connection's, never the host's or another client's.
 *
 * A paired client (a phone, or a desktop client of a remote server) that launches into an existing
 * workspace gets the new tab as its own selection, recorded the way `session.tabs.createTerminal`
 * selects the tab it creates for its caller. In-process callers keep today's behaviour, and a
 * launch that creates its workspace keeps `worktree.create`'s navigation, whose host activation is
 * what runs the new workspace's setup.
 */

import type { AgentLaunchResult, AgentLaunchTarget } from '../../../../shared/agent-launch-intent'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { RpcContext } from '../core'

/** The paired client whose view this launch should move, or null when it moves the host's. */
export function agentLaunchCallerNavigationId(
  target: AgentLaunchTarget,
  context: Pick<RpcContext, 'clientKind' | 'pairedDeviceId'>
): string | null {
  if (target.kind !== 'existing' || context.clientKind === undefined) {
    return null
  }
  return context.pairedDeviceId?.trim() || null
}

/** Bookkeeping, never a gate: the agent already runs, so a failure here only leaves the view as it was. */
export function selectAgentLaunchTabForCaller(
  runtime: Pick<OrcaRuntimeService, 'selectCreatedMobileSessionTabForClient'>,
  result: AgentLaunchResult,
  clientNavigationId: string
): void {
  const { outcome } = result
  // Found by pane or session, never by a predicted tab id.
  const surface =
    outcome.kind === 'terminal'
      ? outcome.paneKey
        ? parsePaneKey(outcome.paneKey)
        : null
      : { sessionId: outcome.sessionId }
  if (!surface) {
    return
  }
  try {
    if (
      !runtime.selectCreatedMobileSessionTabForClient(
        result.worktreeId,
        surface,
        clientNavigationId
      )
    ) {
      console.warn('[agent-launch] the launch ran; its tab was not published to select')
    }
  } catch (error) {
    console.warn('[agent-launch] the launch ran; selecting its tab for the caller did not', error)
  }
}
