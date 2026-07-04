import type { Store } from '../persistence'

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
    const hostId = meta.hostId ?? 'legacy-local'
    hostCounts.set(hostId, (hostCounts.get(hostId) ?? 0) + 1)
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

function countTerminalLeaves(node: { type: string; children?: unknown[] } | null): number {
  if (!node) {
    return 0
  }
  if (node.type === 'leaf') {
    return 1
  }
  let count = 0
  for (const child of node.children ?? []) {
    count += countTerminalLeaves(child as Parameters<typeof countTerminalLeaves>[0])
  }
  return count
}
