// Japanese terminology fixes for Orca's workspace / worktree vocabulary (round 6).
//
// workspace → ワークスペース        worktree → ワークツリー
//
// MT sometimes swaps the two — "Open Parent Worktree" renders as 親ワークスペースを開く
// and "Remove workspace" renders as ワークツリーを削除.  The rules below are guarded on
// the English source so strings naming both terms are left alone.
//
// English "working-tree" is deliberately not folded in: in UI copy it qualifies
// a file, not the worktree object, so a third near-identical loanword buys nothing.
export const JA_PHRASE_FIXES_ROUND6 = [
  // English names only the worktree → Japanese must not demote it to a workspace.
  {
    pattern: /ワークスペース/g,
    replacement: 'ワークツリー',
    whenEnMatches: /^(?![\s\S]*workspace)[\s\S]*work\s?tree/i
  },
  // English names only the workspace → Japanese must not promote it to a worktree.
  {
    pattern: /ワークツリー/g,
    replacement: 'ワークスペース',
    whenEnMatches: /^(?![\s\S]*work\s?tree)[\s\S]*workspace/i
  }
]
