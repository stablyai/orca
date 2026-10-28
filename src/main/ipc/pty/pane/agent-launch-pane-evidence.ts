import { makePaneKey } from '../../../../shared/stable-pane-id'
import type { IsAgentLaunchPaneLive } from '../../../agent-launch/agent-launch-pane-attachment'
import type { Store } from '../../../persistence'
import type { OrcaRuntimeService } from '../../../runtime/orca-runtime'
import { resolveStablePaneOwner } from './stable-owner'

/** Live or restored agent bindings hold launch panes; failed evidence reads leave the spawn unchanged. */
export function agentLaunchPaneLiveness(
  deps: { runtime?: OrcaRuntimeService; store?: Store },
  pane: { worktreeId: string; tabId: string; leafId: string; connectionId?: string | null }
): IsAgentLaunchPaneLive {
  const { runtime, store } = deps
  const paneKey = makePaneKey(pane.tabId, pane.leafId)
  return () => {
    try {
      return (
        (runtime?.hasLiveTerminalForPaneKey(paneKey) ?? false) ||
        resolveStablePaneOwner(runtime, store, paneKey, pane.worktreeId, pane.connectionId) !== null
      )
    } catch {
      return false
    }
  }
}
