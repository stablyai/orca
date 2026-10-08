import { toSshExecutionHostId } from '../../../../shared/execution-host'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import {
  readLaunchBookkeepingOr,
  type AgentLaunchPaneEvidence
} from '../../../agent-launch/agent-launch-pane-attachment'
import type { Store } from '../../../persistence'
import type { OrcaRuntimeService } from '../../../runtime/orca-runtime'
import { resolveStablePaneOwner } from './stable-owner'

/** What a pane's spawn reads to learn whether an agent launch owns it. */
export function agentLaunchPaneEvidence(
  deps: { runtime?: OrcaRuntimeService; store?: Store },
  pane: { worktreeId: string; tabId: string; leafId: string; connectionId?: string | null }
): AgentLaunchPaneEvidence {
  const { runtime, store } = deps
  const paneKey = makePaneKey(pane.tabId, pane.leafId)
  return {
    // The persisted binding counts: a restored pane whose agent survived in the daemon is adopted
    // by the spawn below, never called unconfirmed.
    isPaneLive: () =>
      readLaunchBookkeepingOr(
        () =>
          (runtime?.hasLiveTerminalForPaneKey(paneKey) ?? false) ||
          resolveStablePaneOwner(runtime, store, paneKey, pane.worktreeId, pane.connectionId) !==
            null,
        false
      ),
    openedRows: (ownedPane, now) =>
      readLaunchBookkeepingOr(
        () =>
          runtime?.openedAgentSessionRecordStore()?.listOperationRowsOwningPane(ownedPane, now) ??
          null,
        null
      ),
    launchPaneOnTab: () =>
      readLaunchBookkeepingOr(() => {
        if (!store || typeof store.getWorkspaceSession !== 'function') {
          return null
        }
        const session = store.getWorkspaceSession(
          pane.connectionId ? toSshExecutionHostId(pane.connectionId) : undefined
        )
        const launchPane = session.tabsByWorktree?.[pane.worktreeId]?.find(
          (candidate) => candidate.id === pane.tabId
        )?.agentLaunchPane
        return launchPane?.leafId === pane.leafId ? launchPane : null
      }, null),
    openRows: async (ownedPane, now) => {
      if (!runtime) {
        throw new Error('runtime_unavailable')
      }
      return (await runtime.openAgentSessionRecordStore()).listOperationRowsOwningPane(
        ownedPane,
        now
      )
    },
    now: () => Date.now()
  }
}
