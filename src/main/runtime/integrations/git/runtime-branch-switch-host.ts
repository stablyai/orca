import type { AgentProcessVerdict } from '../../../../shared/agent-status/process/agent-process-presence'
import type { Worktree } from '../../../../shared/worktree/types'
import {
  CLEARED_HOSTED_REVIEW_LINK_UPDATES,
  HOSTED_REVIEW_LINK_KEYS
} from '../../../../shared/worktree/hosted-review-links'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import { splitWorktreeIdForFilesystem } from '../../../../shared/worktree/id'
import { isWslMoveWorktreeBlocked } from '../../../persistence/moving-wsl-projects/orchestration/wsl-move-background-backoff'
import { worktreeRowTarget } from '../../../persistence/host-qualified-worktree-meta'
import type { RuntimeStore } from '../../construction/runtime-store-contract'
import { findAgentSwitchBlocker, type AgentSwitchRow } from './branch-switch-agent-blocker'
import { isPathInsideOrEqual } from '../../../../shared/cross-platform-path'
import type { RuntimeGitCommandHost } from './runtime-git-command-target'

type ConnectedPty = { ptyId: string; worktreeId: string; connected: boolean }

export type BranchSwitchHostSources<P extends ConnectedPty> = {
  getStore: () => RuntimeStore | null
  readAgentRows: () => readonly AgentSwitchRow[]
  readAgentPaneRows: (paneKey: string) => readonly AgentSwitchRow[]
  ptys: () => Iterable<P>
  paneOf: (pty: P) => { tabId: string | null; paneKey: string | null }
  terminalHandlesOf: (ptyId: string) => readonly string[]
  hasSyncedTab: (tabId: string) => boolean
  /** Tab ids saved in these workspaces' sessions on any host. */
  savedTabIds: (workspaceIds: ReadonlySet<string>) => Iterable<string>
  probeProcess: (paneKey: string) => Promise<AgentProcessVerdict | null>
  notifyBranchChanged: (repoId: string) => void
  /** Every folder workspace's directory by id; read at most once per switch. */
  folderWorkspacePaths: () => ReadonlyMap<string, string>
}

type WorkspacePathOf = (workspaceId: string) => string | undefined

/** The saved-session and folder sources, read from the store only when a switch needs them. */
export function storeBackedBranchSwitchSources(
  getStore: () => RuntimeStore | null
): Pick<BranchSwitchHostSources<ConnectedPty>, 'savedTabIds' | 'folderWorkspacePaths'> {
  return {
    savedTabIds: (workspaceIds) => {
      const store = getStore()
      return (store?.getWorkspaceSessionHostIds?.() ?? []).flatMap((hostId) => {
        const tabsByWorktree = store?.getWorkspaceSession?.(hostId)?.tabsByWorktree ?? {}
        return [...workspaceIds].flatMap((id) => (tabsByWorktree[id] ?? []).map((tab) => tab.id))
      })
    },
    folderWorkspacePaths: () =>
      new Map(
        (getStore()?.getFolderWorkspaces?.() ?? []).map((folder) => [folder.id, folder.folderPath])
      )
  }
}

/** Resolve workspace directories without a catalog scan, reading folder workspaces once if needed. */
function createWorkspacePathOf(
  sources: Pick<BranchSwitchHostSources<ConnectedPty>, 'folderWorkspacePaths'>
): WorkspacePathOf {
  let folders: ReadonlyMap<string, string> | null = null
  return (workspaceId) => {
    const scope = parseWorkspaceKey(workspaceId)
    if (scope?.type === 'folder') {
      return (folders ??= sources.folderWorkspacePaths()).get(scope.folderWorkspaceId)
    }
    // A worktree id spells its checkout path.
    return splitWorktreeIdForFilesystem(scope?.type === 'worktree' ? scope.worktreeId : workspaceId)
      ?.worktreePath
  }
}

/**
 * The sidebar roster's admission, built once per switch from this checkout only: a tab saved in
 * the candidates' workspace sessions or synced here, or a connected terminal of this checkout
 * matched by pane, tab or handle.
 */
function buildTerminalLiveness<P extends ConnectedPty>(
  sources: BranchSwitchHostSources<P>,
  checkoutPath: string,
  candidates: readonly AgentSwitchRow[],
  workspacePathOf: WorkspacePathOf
): (row: Pick<AgentSwitchRow, 'paneKey' | 'tabId' | 'terminalHandle'>) => boolean {
  const paneKeys = new Set<string>()
  const tabIds = new Set<string>()
  const handles = new Set<string>()
  for (const pty of sources.ptys()) {
    const path = pty.connected ? workspacePathOf(pty.worktreeId) : undefined
    if (path === undefined || !isPathInsideOrEqual(checkoutPath, path)) {
      continue
    }
    const pane = sources.paneOf(pty)
    if (pane.paneKey) {
      paneKeys.add(pane.paneKey)
    }
    if (pane.tabId) {
      tabIds.add(pane.tabId)
    }
    for (const handle of sources.terminalHandlesOf(pty.ptyId)) {
      handles.add(handle)
    }
  }
  const workspaceIds = new Set(
    candidates.flatMap((row) => (row.worktreeId ? [row.worktreeId] : []))
  )
  for (const tabId of sources.savedTabIds(workspaceIds)) {
    tabIds.add(tabId)
  }
  return (row) =>
    paneKeys.has(row.paneKey) ||
    (row.tabId !== undefined && (tabIds.has(row.tabId) || sources.hasSyncedTab(row.tabId))) ||
    (row.terminalHandle !== undefined && handles.has(row.terminalHandle))
}

/** Host side of an in-app branch switch: the agent refusal and what a landed switch records. */
export function createBranchSwitchHost<P extends ConnectedPty>(
  sources: BranchSwitchHostSources<P>
): Required<Pick<RuntimeGitCommandHost, 'getAgentSwitchBlocker' | 'recordBranchSwitched'>> {
  return {
    getAgentSwitchBlocker: async (checkoutPath) => {
      const workspacePathOf = createWorkspacePathOf(sources)
      return findAgentSwitchBlocker({
        checkoutPath,
        readRows: sources.readAgentRows,
        readPaneRows: sources.readAgentPaneRows,
        pathOfWorktree: workspacePathOf,
        buildTerminalLiveness: (candidates) =>
          buildTerminalLiveness(sources, checkoutPath, candidates, workspacePathOf),
        probeProcess: sources.probeProcess
      })
    },
    // Watchers only cover desktop-hosted local repos, so Orca's own switch updates every client
    // itself; the user's choice also ends first-work automatic branch naming.
    recordBranchSwitched: (
      worktree: Pick<Worktree, 'id' | 'hostId' | 'repoId'>,
      detached = false
    ) => {
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
          ...(!detached ? { branchNameIsUserChosen: true } : {})
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
