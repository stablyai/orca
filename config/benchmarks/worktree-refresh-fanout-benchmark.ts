export type WorktreeRefreshFanoutResult = {
  scenario: string
  repoCount: number
  repoScopedRefreshes: number
  localGitProcessesIfGitRepos: number
  lineageRefreshes: number
  idleWindowSeconds: number | null
  source: string
}

function fanoutFor(repoCount: number): WorktreeRefreshFanoutResult[] {
  return [
    {
      scenario: 'idle visible app, no repo/runtime event',
      repoCount,
      repoScopedRefreshes: 0,
      localGitProcessesIfGitRepos: 0,
      lineageRefreshes: 0,
      idleWindowSeconds: 60,
      source: 'Code search found no fixed fetchAllWorktrees/listWorktrees idle interval.'
    },
    {
      scenario: 'App startup fetchAllWorktrees',
      repoCount,
      repoScopedRefreshes: repoCount,
      localGitProcessesIfGitRepos: repoCount,
      lineageRefreshes: 1,
      idleWindowSeconds: null,
      source: 'App.tsx startup hydration calls fetchAllWorktrees(), then fetchWorktreeLineage().'
    },
    {
      scenario: 'Sidebar repo-count effect after repo list changes',
      repoCount,
      repoScopedRefreshes: repoCount,
      localGitProcessesIfGitRepos: repoCount,
      lineageRefreshes: 0,
      idleWindowSeconds: null,
      source: 'Sidebar effect runs fetchAllWorktrees() when repos.length changes.'
    },
    {
      scenario: 'Startup plus sidebar first repo-count effect',
      repoCount,
      repoScopedRefreshes: repoCount * 2,
      localGitProcessesIfGitRepos: repoCount * 2,
      lineageRefreshes: 1,
      idleWindowSeconds: null,
      source:
        'Normal startup can plausibly hit the App startup path plus the Sidebar repo-count effect.'
    },
    {
      scenario: 'worktrees:changed for one repo',
      repoCount,
      repoScopedRefreshes: 1,
      localGitProcessesIfGitRepos: 1,
      lineageRefreshes: 1,
      idleWindowSeconds: null,
      source:
        'useIpcEvents handleWorktreesChanged(repoId) refreshes the touched repo, then lineage.'
    },
    {
      scenario: 'runtime reposChanged / remote connect for one host',
      repoCount,
      repoScopedRefreshes: repoCount,
      localGitProcessesIfGitRepos: 0,
      lineageRefreshes: 1,
      idleWindowSeconds: null,
      source: 'Runtime-host paths call provider listWorktrees once per repo, not local git.'
    },
    {
      scenario: 'Automations page mount',
      repoCount,
      repoScopedRefreshes: repoCount,
      localGitProcessesIfGitRepos: repoCount,
      lineageRefreshes: 0,
      idleWindowSeconds: null,
      source: 'AutomationsPage mount calls fetchAllWorktrees() before refreshing automations.'
    }
  ]
}

export function runWorktreeRefreshFanoutBenchmark(): WorktreeRefreshFanoutResult[] {
  return [10, 50, 100].flatMap(fanoutFor)
}
