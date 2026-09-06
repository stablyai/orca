import { getRepoSshConnectionId, LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
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
        // Why the resolved SSH target and not the raw `connectionId`: this backfill runs `gh`/git
        // in this process, so any row whose files sit on an SSH host must be skipped — including
        // one that carries only `executionHostId: ssh:…`, which the raw field reads as local.
        if (repo.upstream !== undefined || repo.kind === 'folder' || getRepoSshConnectionId(repo)) {
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
            ? await detectGitHubAvatarIcon(repo.path, LOCAL_EXECUTION_HOST_ID, upstream)
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
