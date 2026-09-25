/**
 * Which view a launch moves: the requesting connection's, never the host's or another client's.
 *
 * A paired client (a phone, or a desktop client of a remote server) that launches into an existing
 * workspace gets the new tab as its own selection, recorded the way that client's own tab tap
 * records it (`session.tabs.activate` with caller navigation). In-process callers keep today's
 * behaviour, and a launch that creates its workspace keeps `worktree.create`'s navigation, whose
 * host activation is what runs the new workspace's setup.
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
export async function selectAgentLaunchTabForCaller(
  runtime: Pick<OrcaRuntimeService, 'activateMobileSessionTab' | 'listMobileSessionTabs'>,
  result: AgentLaunchResult,
  clientNavigationId: string
): Promise<void> {
  const worktree = `id:${result.worktreeId}`
  const select = { clientNavigationId, navigation: 'caller' as const }
  try {
    const { outcome } = result
    if (outcome.kind === 'terminal') {
      const pane = outcome.paneKey ? parsePaneKey(outcome.paneKey) : null
      if (pane) {
        await runtime.activateMobileSessionTab(worktree, pane.tabId, pane.leafId, select)
      }
      return
    }
    // Found by session, never by a predicted tab id.
    const tabs = await runtime.listMobileSessionTabs(worktree, clientNavigationId)
    const chat = tabs.tabs.find(
      (tab) => tab.type === 'agent-session' && tab.sessionId === outcome.sessionId
    )
    if (chat) {
      await runtime.activateMobileSessionTab(worktree, chat.id, undefined, select)
    }
  } catch (error) {
    console.warn('[agent-launch] the launch ran; selecting its tab for the caller did not', error)
  }
}
