// Without mobile history, match the desktop’s focused workspace instead of picking arbitrary list order.

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
  let best = worktrees[0]
  for (const w of worktrees) {
    if ((w.lastOutputAt ?? 0) > (best.lastOutputAt ?? 0)) {
      best = w
    }
  }
  return best
}
