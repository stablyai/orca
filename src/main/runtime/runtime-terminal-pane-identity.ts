import { AgentLaunchPaneAlreadyLiveError } from '../../shared/agent-launch-pane-already-live'
import { parsePaneKey } from '../../shared/stable-pane-id'

/** A caller-minted `tabId:leafId` as the pair `createTerminal` adopts; an unparsable key yields
 *  nothing, so the runtime mints its own and the reported `paneKey` shows the caller it lost. */
export function paneIdentity(paneKey: string | undefined): { tabId?: string; leafId?: string } {
  const pane = paneKey ? parsePaneKey(paneKey) : null
  return pane ? { tabId: pane.tabId, leafId: pane.leafId } : {}
}

/** Whether spawn attached to a live pane; refused when the caller required a fresh one, including
 *  when the provider session's canonical owner answered instead of a new PTY. */
export function admitStablePaneAdoption(
  result: { stablePaneOwner?: unknown; agentSessionEnsure?: { disposition: string } },
  opts: { requireFreshPane?: boolean }
): boolean {
  const adoptsLiveOwner =
    Boolean(result.stablePaneOwner) || result.agentSessionEnsure?.disposition === 'adopted'
  if (adoptsLiveOwner && opts.requireFreshPane) {
    throw new AgentLaunchPaneAlreadyLiveError()
  }
  return Boolean(result.stablePaneOwner)
}
