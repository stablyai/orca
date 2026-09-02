import type { GitHubOwnerRepo } from '../../shared/github/pull-request-types'
import type { Repo } from '../../shared/repo-types'
import { getRepoUpstream } from '../github/client'
import { detectGitHubAvatarIcon } from '../repo-icon-autodetect'
import type { RuntimeStore } from './runtime-store-contract'

export class RuntimeRepositoryForkBackfill {
  private started = false

  constructor(
    private readonly getStore: () => RuntimeStore | null,
    private readonly notifyChanged: () => void
  ) {}

  start(): void {
    if (this.started) {
      return
    }
    this.started = true
    void this.run()
  }

  async run(): Promise<void> {
    try {
      const store = this.getStore()
      if (!store) {
        throw new Error('runtime_unavailable')
      }
      let changed = false
      for (const repo of store.getRepos()) {
        if (repo.upstream !== undefined || repo.kind === 'folder' || repo.connectionId) {
          continue
        }
        let upstream: GitHubOwnerRepo | null
        try {
          upstream = await getRepoUpstream(repo.path, null)
        } catch {
          continue
        }
        const repoIcon =
          upstream && repo.repoIcon?.type === 'image' && repo.repoIcon.source === 'github'
            ? await detectGitHubAvatarIcon(repo.path, null, upstream)
            : null
        const current = store.getRepos().find((candidate) => candidate.id === repo.id)
        if (!current || current.upstream !== undefined) {
          continue
        }
        const updates: Partial<Repo> = { upstream: upstream ?? null }
        if (
          repoIcon &&
          current.repoIcon?.type === 'image' &&
          current.repoIcon.source === 'github'
        ) {
          updates.repoIcon = repoIcon
        }
        store.updateRepo(repo.id, updates)
        changed = true
      }
      if (changed) {
        this.notifyChanged()
      }
    } catch {
      // Best-effort startup migration.
    }
  }
}
