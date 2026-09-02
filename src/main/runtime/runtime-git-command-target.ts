import type { GlobalSettings } from '../../shared/global-settings-types'
import type { Repo } from '../../shared/repo-types'
import type { GitPushTarget, GitWorktreeInfo, Worktree } from '../../shared/worktree/types'
import type { GitRuntimeOptions } from '../git/git-runtime-options'
import type { CommitMessageAgentEnvironmentResolvers } from '../text-generation/commit-message-agent-environment'
import type { PullRequestLinkedIssueMeta } from '../source-control/pull-request-linked-issue'
import { normalizeRuntimeRelativePath } from './runtime-relative-paths'

export type ResolvedRuntimeGitWorktree = Worktree & { git: GitWorktreeInfo }

export type RuntimeGitTarget = {
  worktree: ResolvedRuntimeGitWorktree
  repo?: Repo
  connectionId?: string
  localGitOptions?: GitRuntimeOptions
}

export type RuntimeGitCommandHost = {
  resolveRuntimeGitTarget(selector: string): Promise<RuntimeGitTarget>
  getRuntimeSettings(): GlobalSettings
  getCommitMessageAgentEnvironment?(): CommitMessageAgentEnvironmentResolvers | undefined
  /** `undefined` keeps cached metadata; `null` is the authoritative unlinked answer. */
  getWorktreeLinkedIssue?(worktreeId: string): number | null | undefined
  getWorktreeLinkedIssueMeta?(worktreeId: string): PullRequestLinkedIssueMeta | null | undefined
  /** Why (#17828 review follow-up): RuntimeGitSyncCommands deliberately materializes with
   *  no store (avoids unrelated ownership-inheritance/refspec-migration side effects), so a
   *  lazily-minted remote still needs a way back into the store's `pushTarget.remoteCreated`
   *  for #17842's orphan sweep. Called only when materialize reports `remoteCreated: true`. */
  persistMaterializedPushTarget?(worktreeId: string, pushTarget: GitPushTarget): void
}

export function localGitOptionsForTarget(target: RuntimeGitTarget): GitRuntimeOptions {
  return target.connectionId ? {} : (target.localGitOptions ?? {})
}

export function normalizeRuntimeGitRelativePath(filePath: string): string {
  const relativePath = normalizeRuntimeRelativePath(filePath)
  if (relativePath === '') {
    // Why: an empty Git pathspec can mutate the whole worktree.
    throw new Error('invalid_relative_path')
  }
  return relativePath
}
