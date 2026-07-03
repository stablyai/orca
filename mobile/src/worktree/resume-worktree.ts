// Picks the worktree the home-screen Resume card falls back to for a host when
// there's no mobile session history yet. Mirrors the desktop's focused
// workspace (worktree.ps marks exactly one isActive) rather than an arbitrary
// list-order pick, so a cold launch resumes the right thing.

export type ResumeCandidate = {
  isActive?: boolean
  lastOutputAt?: number
}

export function pickResumeWorktree<T extends ResumeCandidate>(worktrees: T[]): T | null {
  if (worktrees.length === 0) {
    return null
  }
  const desktopActive = worktrees.find((w) => w.isActive)
  if (desktopActive) {
    return desktopActive
  }
  // No desktop focus → most recent terminal output, else the first.
  let best = worktrees[0]
  for (const w of worktrees) {
    if ((w.lastOutputAt ?? 0) > (best.lastOutputAt ?? 0)) {
      best = w
    }
  }
  return best
}
