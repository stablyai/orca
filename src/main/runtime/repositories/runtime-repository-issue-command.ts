import { getRepoDialableSshTargetId } from '../../../shared/execution-host'
import type { GitRuntimeOptions } from '../../git/git-runtime-options'
import type { Repo } from '../../../shared/repo-types'
import {
  readIssueCommandUnlessWslStopped,
  writeIssueCommandUnlessWslStopped
} from '../../workspace-hooks/issue-command-file'
import { isFolderRepo } from '../../../shared/repo-kind'
import { joinWorktreeRelativePath } from '../files/paths/runtime-relative-paths'
import type { RuntimeStore } from '../construction/runtime-store-contract'
import { assertWslMoveRepoWritable } from '../../persistence/moving-wsl-projects/wsl-move-scope-guard'

type RuntimeRepositoryIssueCommandDeps = {
  resolveRepo: (selector: string) => Promise<Repo>
  getLocalGitArgs: (repo: Repo) => [] | [GitRuntimeOptions]
  getStore?: () => RuntimeStore | null
}

export class RuntimeRepositoryIssueCommand {
  constructor(private readonly deps: RuntimeRepositoryIssueCommandDeps) {}

  async read(repoSelector: string, options: { wakeWslDistro?: boolean } = {}) {
    const repo = await this.deps.resolveRepo(repoSelector)
    if (isFolderRepo(repo)) {
      return {
        localContent: null,
        sharedContent: null,
        effectiveContent: null,
        localFilePath: '',
        source: 'none' as const
      }
    }
    const connectionId = getRepoDialableSshTargetId(repo)
    if (!connectionId) {
      // A paired client's Settings render must not start this host's stopped distro (E9).
      return readIssueCommandUnlessWslStopped(repo.path, {
        ...options,
        gitOptions: () => this.deps.getLocalGitArgs(repo)[0] ?? {}
      })
    }
    // Why: an `ssh:` repo is not served here; it reads as having no command.
    return {
      localContent: null,
      sharedContent: null,
      effectiveContent: null,
      localFilePath: joinWorktreeRelativePath(repo.path, '.orca/issue-command'),
      source: 'none' as const
    }
  }

  /** Save a private override on its execution host; blank content restores the shared command. */
  async write(
    repoSelector: string,
    content: string,
    options: { wakeWslDistro?: boolean } = {}
  ): Promise<{ ok: true }> {
    const repo = await this.deps.resolveRepo(repoSelector)
    assertWslMoveRepoWritable(this.deps.getStore?.() ?? undefined, repo)
    if (isFolderRepo(repo)) {
      return { ok: true }
    }
    // Why: an `ssh:` repo is not served here; the write is dropped, as when it was unreachable.
    if (!getRepoDialableSshTargetId(repo)) {
      await writeIssueCommandUnlessWslStopped(
        repo.path,
        content,
        () => this.deps.getLocalGitArgs(repo)[0] ?? {},
        options
      )
    }
    return { ok: true }
  }
}
