// Workspace / worktree / primary terminology guards for all locales.
//
// A workspace is the entry Orca shows in the sidebar; a worktree is the git checkout behind it.
// They are deleted, removed, and created by different actions, so MT output that swaps the two
// tells the user a different object is about to disappear.
//
// English "working-tree" is deliberately excluded: in UI copy it qualifies a file, not the
// worktree object, so a third near-identical loanword buys nothing.

export const JA_WORKSPACE_WORKTREE_FIXES = [
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

export const KO_WORKSPACE_WORKTREE_FIXES = [
  // 작업 트리 reads as a generic "task tree" and collides with Orca's Tasks surface.
  { pattern: /작업\s?트리/g, replacement: '워크트리', whenEnMatches: /work\s?tree/i },
  // English names only the workspace → Korean must not promote it to a worktree.
  {
    pattern: /워크트리/g,
    replacement: '워크스페이스',
    whenEnMatches: /^(?![\s\S]*work\s?tree)[\s\S]*workspace/i
  },
  // English names only the worktree → Korean must not demote it to a workspace.
  {
    pattern: /워크스페이스/g,
    replacement: '워크트리',
    whenEnMatches: /^(?![\s\S]*workspace)[\s\S]*work\s?tree/i
  },
  {
    pattern: /기본 워크트리/g,
    replacement: '주 워크트리',
    whenEnMatches: /primary\s+work\s?tree/i
  },
  { pattern: /기본 체크아웃/g, replacement: '주 체크아웃', whenEnMatches: /primary checkout/i },
  { pattern: /기본 브랜치/g, replacement: '주 브랜치', whenEnMatches: /primary branch/i },
  // The bare "primary" badge on a worktree card — 기본 there reads as "default branch".
  { pattern: /^기본$/, replacement: '주', whenEnMatches: /^primary$/i }
]

export const ZH_WORKSPACE_WORKTREE_FIXES = [
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
