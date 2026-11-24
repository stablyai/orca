import {
  withWorkerLeaf,
  type WorkerTabStamp
} from '../../../../shared/orchestration/workers/worker-tab-stamp'
import type { RuntimePtyController } from '../lifecycle/runtime-pty-controller-contract'
import { AgentLaunchPaneAlreadyLiveError } from '../../../../shared/agent-launch/contracts/agent-launch-pane-already-live'
import {
  isTerminalLeafId,
  makePaneKey,
  parsePaneKey
} from '../../../../shared/workspace-layout/stable-pane-id'
import { isValidHostTerminalTabId } from '../../../../shared/workspace-layout/terminal-surfaces/terminal-tab-id'
import { randomUUID } from 'node:crypto'

export function allocateTerminalPaneIdentity(opts: {
  tabId?: string
  leafId?: string
  workerTab?: WorkerTabStamp
}): {
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
  if (opts.workerTab) {
    opts.workerTab = withWorkerLeaf(opts.workerTab, leafId)
  }
  return { tabId, leafId, paneKey: makePaneKey(tabId, leafId) }
}

/** Adopt valid caller-minted tabId:leafId; otherwise mint locally and report the replacement paneKey. */
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

export function materializedStablePaneReply(
  adoption: NonNullable<Awaited<ReturnType<NonNullable<RuntimePtyController['adoptStablePane']>>>>,
  fallbackHandle: string
) {
  const { owner, result } = adoption
  return {
    ...result,
    wslDistro: result.wslDistro ?? undefined,
    stablePaneOwner: {
      handle: owner.handle ?? fallbackHandle,
      tabId: owner.tabId,
      leafId: owner.leafId
    }
  }
}

/** The startup terminal's caller-named surface: its pane, title and orchestration worker stamp. */
export function startupTerminalSurface(request: {
  startupPaneKey?: string
  startupTitle?: string
  startupWorkerTab?: WorkerTabStamp
}): { tabId?: string; leafId?: string; title?: string; workerTab?: WorkerTabStamp } {
  return {
    ...paneIdentity(request.startupPaneKey),
    ...(request.startupTitle ? { title: request.startupTitle } : {}),
    ...(request.startupWorkerTab ? { workerTab: request.startupWorkerTab } : {})
  }
}
