import type { Store } from '../persistence'
import { parseExecutionHostId } from '../../shared/execution-host'

export type DiagnosticRuntimeStore = Pick<Store, 'getRepos' | 'getAllWorktreeMeta'> & {
  getProjects?: Store['getProjects']
  getProjectHostSetups?: Store['getProjectHostSetups']
  getFolderWorkspaces?: Store['getFolderWorkspaces']
  getWorkspaceSession?: Store['getWorkspaceSession']
}

export function collectRuntimeDiagnosticCounts(
  store: DiagnosticRuntimeStore
): Record<string, unknown> {
  const session = store.getWorkspaceSession?.()
  const tabsByWorktree = session?.tabsByWorktree ?? {}
  const terminalTabCount = Object.values(tabsByWorktree).reduce((sum, tabs) => sum + tabs.length, 0)
  const terminalPaneCount = Object.values(session?.terminalLayoutsByTabId ?? {}).reduce(
    (sum, layout) => sum + countTerminalLeaves(layout.root),
    0
  )
  const worktreeMeta = store.getAllWorktreeMeta()
  const hostCounts = new Map<string, number>()
  for (const meta of Object.values(worktreeMeta)) {
    const hostBucket = getDiagnosticHostBucket(meta.hostId)
    hostCounts.set(hostBucket, (hostCounts.get(hostBucket) ?? 0) + 1)
  }
  return {
    repoCount: store.getRepos().length,
    projectCount: store.getProjects?.().length ?? 0,
    projectHostSetupCount: store.getProjectHostSetups?.().length ?? 0,
    folderWorkspaceCount: store.getFolderWorkspaces?.().length ?? 0,
    worktreeCount: Object.keys(worktreeMeta).length,
    terminalTabCount,
    terminalPaneCount,
    runtimeHostCounts: Object.fromEntries(hostCounts)
  }
}

function getDiagnosticHostBucket(hostId: string | null | undefined): string {
  if (!hostId) {
    return 'legacy-local'
  }
  const parsed = parseExecutionHostId(hostId)
  // Why: SSH/runtime ids can reveal host labels; diagnostics only need host kind counts.
  return parsed?.kind ?? 'unknown'
}

type DiagnosticTerminalLayoutNode = {
  type: string
  first?: DiagnosticTerminalLayoutNode | null
  second?: DiagnosticTerminalLayoutNode | null
}

function countTerminalLeaves(node: DiagnosticTerminalLayoutNode | null): number {
  if (!node) {
    return 0
  }
  if (node.type === 'leaf') {
    return 1
  }
  if (node.type === 'split') {
    return countTerminalLeaves(node.first ?? null) + countTerminalLeaves(node.second ?? null)
  }
  return 0
}
