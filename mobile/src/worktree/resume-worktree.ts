// Picks the worktree the home-screen Resume card falls back to for a host when
// there's no mobile session history yet. Mirrors the desktop's focused
// workspace (worktree.ps marks exactly one isActive) rather than an arbitrary
// list-order pick, so a cold launch resumes the right thing.

export type ResumeCandidate = {
  isActive?: boolean
  lastOutputAt?: number
  workspaceKind?: 'git' | 'folder-workspace' | 'floating-workspace'
}

export function pickResumeWorktree<T extends ResumeCandidate>(worktrees: T[]): T | null {
  // Why: the floating sentinel is terminal-only and never a cold-launch resume
  // target, even when pinned/active, so a phone never auto-opens it.
  const resumable = worktrees.filter((w) => w.workspaceKind !== 'floating-workspace')
  if (resumable.length === 0) {
    return null
  }
  const desktopActive = resumable.find((w) => w.isActive)
  if (desktopActive) {
    return desktopActive
  }
  // No desktop focus → most recent terminal output, else the first.
  let best = resumable[0]
  for (const w of resumable) {
    if ((w.lastOutputAt ?? 0) > (best.lastOutputAt ?? 0)) {
      best = w
    }
  }
  return best
}
