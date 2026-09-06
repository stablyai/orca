export function useLastVisitedWorktreeRepoId(
  _hostId: string | undefined,
  enabled: boolean
): { loaded: boolean; repoId: string | null } {
  return { loaded: enabled, repoId: null }
}
