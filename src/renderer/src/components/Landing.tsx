import { useCallback, useMemo, useState } from 'react'
import { useAppStore } from '../store'
import NoReposLanding from './landing/NoReposLanding'
import RepoOnboarding, { isOnboardingDismissed } from './landing/RepoOnboarding'

/**
 * Landing is the orchestration shell for Orca's empty/onboarding states.
 * It derives one of four states from the store and delegates rendering:
 *
 *   1. no-repos                          → NoReposLanding
 *   2. repo-selected-main-checkout-only  → RepoOnboarding (create-focused)
 *   3. repo-selected-with-linked         → RepoOnboarding (open-focused)
 *   4. repo-selected-with-active         → should not reach Landing (App.tsx gates this)
 *
 * Why this is a separate shell: the design doc specifies splitting Landing into
 * sub-components to avoid a monolith while keeping Landing as the routing layer.
 */
export default function Landing(): React.JSX.Element {
  const repos = useAppStore((s) => s.repos)
  const activeRepoId = useAppStore((s) => s.activeRepoId)
  const worktreesByRepo = useAppStore((s) => s.worktreesByRepo)

  // Force re-render when a repo is dismissed so we show the correct fallback
  const [dismissEpoch, setDismissEpoch] = useState(0)

  const activeRepo = useMemo(
    () => repos.find((r) => r.id === activeRepoId) ?? null,
    [repos, activeRepoId]
  )

  // Why: onboarding surfaces only linked worktrees (not the main checkout) because
  // the main checkout is not what users mean by "existing worktrees" and treating it
  // as openable from onboarding muddies the decision the UI is trying to help with.
  // This reuses the same git-derived worktree list Orca trusts everywhere else —
  // no second detection path needed.
  const linkedWorktrees = useMemo(() => {
    if (!activeRepoId) {
      return []
    }
    return (worktreesByRepo[activeRepoId] ?? []).filter((w) => !w.isMainWorktree)
  }, [activeRepoId, worktreesByRepo])

  const handleDismiss = useCallback(() => {
    setDismissEpoch((e) => e + 1)
  }, [])

  // State 1: no repos at all
  if (repos.length === 0) {
    return <NoReposLanding />
  }

  // States 2/3: repo selected, show onboarding (unless dismissed)
  // Why: onboarding is shown only when the *selected* repo has no active linked
  // worktree, keeping the repo-centric mental model. The dismissal check uses
  // dismissEpoch to react to in-session dismissals without persisting to disk.
  if (activeRepo && !isOnboardingDismissed(activeRepo.id)) {
    return (
      <RepoOnboarding
        key={`${activeRepo.id}-${dismissEpoch}`}
        repo={activeRepo}
        linkedWorktrees={linkedWorktrees}
        onDismiss={handleDismiss}
      />
    )
  }

  // Fallback: repos exist but none selected, or onboarding was dismissed.
  // Show a minimal prompt so the user isn't staring at a blank screen.
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-background">
      <p className="text-sm text-muted-foreground">
        Select a worktree from the sidebar or create a new one.
      </p>
    </div>
  )
}
