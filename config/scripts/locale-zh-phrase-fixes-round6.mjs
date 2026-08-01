// Chinese terminology fixes for Orca's workspace / worktree / primary vocabulary (round 6).
//
// workspace → 工作区        worktree → 工作树        primary (git) → 主
//
// MT sometimes swaps the two — "Open Parent Worktree" renders as 打开父工作区
// and "Remove workspace" renders as 删除工作树.  The rules below are guarded on
// the English source so strings naming both terms are left alone.
//
// English "working-tree" is deliberately not folded in: in UI copy it qualifies
// a file, not the worktree object, so a third near-identical compound buys nothing.
export const ZH_PHRASE_FIXES_ROUND6 = [
  // English names only the worktree → Chinese must not demote it to a workspace.
  {
    pattern: /工作区/g,
    replacement: '工作树',
    whenEnMatches: /^(?![\s\S]*workspace)[\s\S]*work\s?tree/i
  },
  // English names only the workspace → Chinese must not promote it to a worktree.
  {
    pattern: /工作树/g,
    replacement: '工作区',
    whenEnMatches: /^(?![\s\S]*work\s?tree)[\s\S]*workspace/i
  },
  // Bare "primary" badge — 主要 reads as "important", 主 is the git-primary term.
  { pattern: /^主要$/, replacement: '主', whenEnMatches: /^primary$/i }
]
