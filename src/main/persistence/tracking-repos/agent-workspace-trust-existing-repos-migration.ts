import type { Repo } from '../../../shared/repo-types'
import type { GlobalSettings } from '../../../shared/global-settings-types'

type TrustMigrationSettings = Partial<
  Pick<GlobalSettings, 'agentWorkspaceTrustEnabled' | 'agentWorkspaceTrustExistingReposMigrated'>
>

/** Repos saved before per-repo decisions keep pre-trust once, unless the user had turned it off globally. */
export function migrateExistingReposAgentWorkspaceTrust(
  repos: Repo[],
  settings: TrustMigrationSettings | undefined,
  markNeedsSave: () => void
): Repo[] {
  if (settings?.agentWorkspaceTrustExistingReposMigrated === true) {
    return repos
  }
  // Persist the marker even with no repos so repos added later are asked.
  markNeedsSave()
  if (settings?.agentWorkspaceTrustEnabled === false) {
    return repos
  }
  return repos.map((repo) =>
    repo.agentWorkspaceTrust === undefined ? { ...repo, agentWorkspaceTrust: 'pre-trust' } : repo
  )
}
