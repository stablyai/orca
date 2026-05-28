import type { GlobalSettings } from '../../shared/types'
import { computeNextGitLabRecents } from '../../shared/gitlab-projects'

export type GitLabProjectRecentsStore = {
  getSettings(): Pick<GlobalSettings, 'gitlabProjects'>
  updateSettings(updates: Pick<GlobalSettings, 'gitlabProjects'>): unknown
}

export function recordGitLabProjectRecent(
  store: GitLabProjectRecentsStore,
  host: string,
  path: string
): void {
  const settings = store.getSettings()
  const existing = settings.gitlabProjects ?? { pinned: [], recent: [] }
  store.updateSettings({
    gitlabProjects: {
      pinned: existing.pinned,
      recent: computeNextGitLabRecents(existing.recent, host, path)
    }
  })
}
