/** Paired launches move the requesting connection's view, whatever the target.
 * A created workspace's Setup tab is the window's own active tab, so host-wide activation of the agent alone would not survive the window's republish.
 * In-process callers retain host navigation; folder creation activates nothing. */

import type { AgentLaunchResult as AgentLaunchPublishedSurface } from '../../../../../shared/agent-launch/contracts/agent-launch-intent'

import { parsePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import type { RpcContext } from '../../core'
import { clientRendersStructuredAgent } from '../structured-sessions/structured-agent-session-policy'
import type { AgentLaunchParams } from '../../../../../shared/rpc-contract/agent-launch/agent-launch-params'
import { agentLaunchTabViewerRule } from './agent-launch-tab-publication'

/** The paired client whose view this launch should move, or null when it moves the host's. */
export function agentLaunchCallerNavigationId(context: Pick<RpcContext, 'caller'>): string | null {
  return context.caller?.kind === 'paired-device' ? context.caller.deviceId : null
}

/** Bookkeeping, never a gate: the agent already runs, so a failure here only leaves the view as it was. */
async function selectAgentLaunchTabForCaller(
  runtime: Pick<OrcaRuntimeService, 'selectCreatedMobileSessionTabForClient'>,
  surface: AgentLaunchPublishedSurface,
  clientNavigationId: string
): Promise<void> {
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
      !(await runtime.selectCreatedMobileSessionTabForClient(
        surface.worktreeId,
        selector,
        clientNavigationId
      ))
    ) {
      console.warn('[agent-launch] the launch ran; its tab was not published to select')
    }
  } catch (error) {
    console.warn('[agent-launch] the launch ran; selecting its tab for the caller did not', error)
  }
}

/** Moves the view the launch asked for: the paired caller's own, or the host window's to a focused chat. */
export async function selectLaunchedTab(
  context: Pick<RpcContext, 'runtime' | 'caller' | 'clientKind'>,
  surface: AgentLaunchPublishedSurface,
  presentation: AgentLaunchParams['presentation'],
  callerNavigationId: string | null
): Promise<void> {
  if (callerNavigationId !== null) {
    if (presentation !== 'background') {
      await selectAgentLaunchTabForCaller(context.runtime, surface, callerNavigationId)
    }
    return
  }
  // A terminal's reveal selects its own tab; a chat's listing alone never moves the window (#5435).
  if (
    surface.outcome.kind === 'structured' &&
    agentLaunchTabViewerRule(context, presentation) === 'focus-window'
  ) {
    context.runtime.focusChatInHostWindow(surface.worktreeId, surface.outcome.sessionId)
  }
}

/**
 * `agent.launch.v2` was defined when Claude and Codex were the only chats, so it vouches for those
 * two. Any other agent's chat needs the client to say it reads it, by the rule tabs and restart
 * offers use; a client that does not gets that agent as a terminal.
 */
export function callerRendersLaunchedChat(
  context: Pick<RpcContext, 'clientKind' | 'clientCapabilities'>,
  agent: string
): boolean {
  return (
    context.clientKind === undefined ||
    agent === 'claude' ||
    agent === 'codex' ||
    clientRendersStructuredAgent(context.clientCapabilities, agent)
  )
}
