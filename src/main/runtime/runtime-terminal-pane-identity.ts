import { AgentLaunchPaneAlreadyLiveError } from '../../shared/agent-launch-pane-already-live'
import { isTerminalLeafId, makePaneKey, parsePaneKey } from '../../shared/stable-pane-id'
import { isValidHostTerminalTabId } from '../../shared/terminal-tab-id'
import { randomUUID } from 'node:crypto'

export function allocateTerminalPaneIdentity(opts: { tabId?: string; leafId?: string }): {
  tabId: string
  leafId: string
  paneKey: string
} {
  const hintedTabId = opts.tabId?.trim()
  const hintedLeafId = opts.leafId
  const canAdopt =
    hintedTabId !== undefined &&
    isValidHostTerminalTabId(hintedTabId) &&
    hintedLeafId !== undefined &&
    isTerminalLeafId(hintedLeafId)
  const tabId = canAdopt ? hintedTabId : randomUUID()
  const leafId = canAdopt ? hintedLeafId : randomUUID()
  return { tabId, leafId, paneKey: makePaneKey(tabId, leafId) }
}

/** A caller-minted `tabId:leafId` as the pair `createTerminal` adopts; an unparsable key yields
 *  nothing, so the runtime mints its own and the reported `paneKey` shows the caller it lost. */
export function paneIdentity(paneKey: string | undefined): { tabId?: string; leafId?: string } {
  const pane = paneKey ? parsePaneKey(paneKey) : null
  return pane ? { tabId: pane.tabId, leafId: pane.leafId } : {}
}

/** Whether spawn attached to a live pane; refused when the caller required a fresh one. */
export function admitStablePaneAdoption(
  result: { stablePaneOwner?: unknown },
  opts: { requireFreshPane?: boolean }
): boolean {
  if (result.stablePaneOwner && opts.requireFreshPane) {
    throw new AgentLaunchPaneAlreadyLiveError()
  }
  return Boolean(result.stablePaneOwner)
}
