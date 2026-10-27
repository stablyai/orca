import {
  getRepoExecutionHostId,
  getRepoSshConnectionId,
  LOCAL_EXECUTION_HOST_ID
} from '../../shared/execution-host'
import type { GitHubOwnerRepo } from '../../shared/github/pull-request-types'
import type { Repo } from '../../shared/repo-types'
import { getRepoUpstream } from '../github/client'
import { detectGitHubAvatarIcon } from '../repo-icon-autodetect'
import type { RuntimeStore } from './runtime-store-contract'
import { isWslMoveRepoBlocked } from '../persistence/moving-wsl-projects/wsl-move-background-backoff'

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
        // Resolve executionHostId too: raw connectionId misses SSH-only rows, whose gh/Git must never run here.
        // WSL-move-fenced repos keep upstream unset for next startup retry.
        if (
          repo.upstream !== undefined ||
          repo.kind === 'folder' ||
          getRepoSshConnectionId(repo) ||
          isWslMoveRepoBlocked(repo)
        ) {
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
        // Qualify by host: WSL moves leave hidden local rows beside same-id host rows.
        const hostId = getRepoExecutionHostId(repo)
        const current = store
          .getRepos()
          .find(
            (candidate) => candidate.id === repo.id && getRepoExecutionHostId(candidate) === hostId
          )
        if (!current || current.upstream !== undefined || isWslMoveRepoBlocked(current)) {
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
        store.updateRepo(current, updates)
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
