// Korean terminology fixes for Orca's workspace / worktree / primary vocabulary (round 6).
//
// A workspace is the entry Orca shows in the sidebar; a worktree is the git checkout behind it.
// They are deleted, removed, and created by different actions, so MT output that swaps the two
// tells the user a different object is about to disappear. Keep the pairing fixed:
//
//   workspace → 워크스페이스        worktree → 워크트리        primary (git) → 주
//
// 기본 stays reserved for "default" (default branch, default value); English distinguishes
// "default branch" from "primary branch" and Korean has to distinguish them too.
//
// English "working-tree" is left for key overrides to paraphrase: in UI copy it is an adjective
// on a file, so a third near-identical loanword beside 워크스페이스/워크트리 buys nothing and
// misnames what is actually missing. The rules below deliberately do not match it.
export const KO_PHRASE_FIXES_ROUND6 = [
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
