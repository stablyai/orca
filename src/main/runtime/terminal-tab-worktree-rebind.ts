export type RebindableRuntimeTab = {
  tabId: string
  worktreeId: string
}

export type RebindableRuntimeLeaf = {
  tabId: string
  worktreeId: string
  ptyId: string | null
}

export type RebindableRuntimePty = {
  ptyId: string
  tabId: string | null
  worktreeId: string
}

export function rebindRuntimeTabWorktreeMaps<
  TTab extends RebindableRuntimeTab,
  TLeaf extends RebindableRuntimeLeaf
>(args: {
  tabId: string
  destWorktreeId: string
  tabs: Map<string, TTab>
  leaves: Map<string, TLeaf>
  ptys: Iterable<RebindableRuntimePty>
  recordPtyWorktree: (ptyId: string, worktreeId: string) => void
}): string[] {
  const tab = args.tabs.get(args.tabId)
  if (tab) {
    args.tabs.set(args.tabId, { ...tab, worktreeId: args.destWorktreeId })
  }
  const ptyIds = new Set<string>()
  for (const [leafKey, leaf] of args.leaves) {
    if (leaf.tabId !== args.tabId) {
      continue
    }
    args.leaves.set(leafKey, { ...leaf, worktreeId: args.destWorktreeId })
    if (leaf.ptyId) {
      ptyIds.add(leaf.ptyId)
      args.recordPtyWorktree(leaf.ptyId, args.destWorktreeId)
    }
  }
  for (const pty of args.ptys) {
    if (pty.tabId !== args.tabId) {
      continue
    }
    ptyIds.add(pty.ptyId)
    args.recordPtyWorktree(pty.ptyId, args.destWorktreeId)
  }
  return [...ptyIds]
}
