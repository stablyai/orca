import type { AgentStatusIpcPayload } from '../../../../shared/agent-status/contracts/agent-status-ipc-payload'
import type { AgentProcessVerdict } from '../../../../shared/agent-status/process/agent-process-presence'
import type { Worktree } from '../../../../shared/worktree/types'
import {
  CLEARED_HOSTED_REVIEW_LINK_UPDATES,
  HOSTED_REVIEW_LINK_KEYS
} from '../../../../shared/worktree/hosted-review-links'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import { splitWorktreeIdForFilesystem } from '../../../../shared/worktree/id'
import { isWslMoveWorktreeBlocked } from '../../../persistence/moving-wsl-projects/wsl-move-background-backoff'
import { worktreeRowTarget } from '../../../persistence/host-qualified-worktree-meta'
import type { RuntimeStore } from '../../runtime-store-contract'
import { findAgentSwitchBlocker } from './branch-switch-agent-blocker'
import type { RuntimeGitCommandHost } from './runtime-git-command-target'

type ConnectedPty = { ptyId: string; connected: boolean }

export type BranchSwitchHostSources<P extends ConnectedPty> = {
  getStore: () => RuntimeStore | null
  readAgentRows: () => readonly AgentStatusIpcPayload[]
  ptys: () => Iterable<P>
  paneOf: (pty: P) => { tabId: string | null; paneKey: string | null }
  terminalHandlesOf: (ptyId: string) => readonly string[]
  syncedTabIds: () => Iterable<string>
  probeProcess: ((paneKey: string) => Promise<AgentProcessVerdict | null>) | null
  notifyBranchChanged: (repoId: string) => void
}

/** Tabs the sidebar roster admits without a live terminal: saved in a workspace session or synced here. */
function listedTabIds(
  sources: Pick<BranchSwitchHostSources<ConnectedPty>, 'syncedTabIds' | 'getStore'>
): Set<string> {
  const ids = new Set(sources.syncedTabIds())
  const store = sources.getStore()
  for (const hostId of store?.getWorkspaceSessionHostIds?.() ?? []) {
    for (const tabs of Object.values(store?.getWorkspaceSession?.(hostId)?.tabsByWorktree ?? {})) {
      for (const tab of tabs) {
        ids.add(tab.id)
      }
    }
  }
  return ids
}

/** Host side of an in-app branch switch: the agent refusal and what a landed switch records. */
export function createBranchSwitchHost<P extends ConnectedPty>(
  sources: BranchSwitchHostSources<P>
): Required<Pick<RuntimeGitCommandHost, 'getAgentSwitchBlocker' | 'recordBranchSwitched'>> {
  return {
    getAgentSwitchBlocker: async (checkoutPath) => {
      const store = sources.getStore()
      return findAgentSwitchBlocker({
        checkoutPath,
        readRows: sources.readAgentRows,
        pathOfWorktree: (worktreeId) => {
          const scope = parseWorkspaceKey(worktreeId)
          return scope?.type === 'folder'
            ? store?.getFolderWorkspace?.(scope.folderWorkspaceId)?.folderPath
            : // A worktree id spells its checkout path, so no catalog scan is needed per switch.
              splitWorktreeIdForFilesystem(
                scope?.type === 'worktree' ? scope.worktreeId : worktreeId
              )?.worktreePath
        },
        // Same admission as the sidebar roster: a listed tab, or a connected terminal by pane, tab or handle.
        hasLiveTerminal: (row) => {
          if (row.tabId !== undefined && listedTabIds(sources).has(row.tabId)) {
            return true
          }
          for (const pty of sources.ptys()) {
            if (!pty.connected) {
              continue
            }
            const pane = sources.paneOf(pty)
            if (
              pane.paneKey === row.paneKey ||
              (row.tabId !== undefined && pane.tabId === row.tabId) ||
              (row.terminalHandle !== undefined &&
                sources.terminalHandlesOf(pty.ptyId).includes(row.terminalHandle))
            ) {
              return true
            }
          }
          return false
        },
        probeProcess: sources.probeProcess
      })
    },
    // Watchers only cover desktop-hosted local repos, so Orca's own switch updates every client
    // itself; the user's choice also ends first-work automatic branch naming.
    recordBranchSwitched: (worktree: Pick<Worktree, 'id' | 'hostId' | 'repoId'>) => {
      const store = sources.getStore()
      try {
        const target = store ? worktreeRowTarget(store, worktree) : undefined
        if (!store || !target || isWslMoveWorktreeBlocked(target.id, target.hostId)) {
          throw new Error('no metadata owner')
        }
        // Read the row this write targets; the unqualified getter may return a same-id twin's.
        const meta =
          store.getWorktreeMetaForHost?.(target.id, target.hostId) ??
          store.getWorktreeMeta(target.id)
        const hasBranchScopedLinks =
          meta !== undefined &&
          (HOSTED_REVIEW_LINK_KEYS.some((key) => meta[key] != null) ||
            meta.pushTarget !== undefined)
        store.setWorktreeMeta(target, {
          ...(hasBranchScopedLinks ? CLEARED_HOSTED_REVIEW_LINK_UPDATES : {}),
          branchNameIsUserChosen: true
        })
      } catch (error) {
        // The switch already landed; bookkeeping must not turn it into a failure. First-work
        // naming then behaves as before.
        console.warn('[branch-switch] could not record the switch for', worktree.id, error)
      }
      sources.notifyBranchChanged(worktree.repoId)
    }
  }
}
