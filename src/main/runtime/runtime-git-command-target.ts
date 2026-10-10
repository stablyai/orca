import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../shared/execution-host'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { Repo } from '../../shared/repo-types'
import type { GitPushTarget, GitWorktreeInfo, Worktree } from '../../shared/worktree/types'
import type { GitRuntimeOptions } from '../git/git-runtime-options'
import {
  ExecutionHostNotDispatchableError,
  resolveGitRouteForHost
} from '../providers/execution-host-provider-dispatch'
import { SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE } from '../providers/ssh-git-dispatch'
import type { SshGitProvider } from '../providers/ssh-git-provider'
import type { CommitMessageAgentEnvironmentResolvers } from '../text-generation/commit-message-agent-environment'
import type { PullRequestLinkedIssueMeta } from '../source-control/pull-request-linked-issue'
import { normalizeRuntimeRelativePath } from './runtime-relative-paths'

export type ResolvedRuntimeGitWorktree = Worktree & { git: GitWorktreeInfo }

export type RuntimeGitTarget = {
  worktree: ResolvedRuntimeGitWorktree
  /**
   * Display and settings metadata only (shared-link paths, source-control AI defaults). It can be
   * a same-id row from another host when the worktree's own host carries none, so it must not
   * decide routing — `executionHostId` does.
   */
  repo?: Repo
  /**
   * The host this worktree's Git runs on. Never optional and never null: the field it replaced
   * (`connectionId?: string`) spelled "runtime host", "unresolved" and "genuinely local" all as
   * `undefined`, so every path that could not resolve answered "local" and ran remote work on the
   * client (#11163). Unresolved now fails at resolution time instead of arriving here as a
   * silently-local target.
   */
  executionHostId: ExecutionHostId
  /** Only consulted when `executionHostId` is `local`; see `localGitOptionsForTarget`. */
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

/**
 * The two hosts this process can itself execute a runtime Git command on, narrowed from the shared
 * host-keyed route in `src/main/providers/execution-host-provider-dispatch.ts`.
 *
 * `runtime:<env>` is deliberately not a variant. Its Git is executed by that environment's own
 * server, and the SSH target on its repo row is that server's *nested* one — addressable only as
 * the pair (environmentId, targetId). Handing that id to this client's SSH table dials a
 * same-named target in the wrong namespace, so it throws rather than routing.
 */
export type RuntimeGitRoute =
  | { kind: 'local' }
  /** `provider: null` is "remote and currently unreachable" — never "run it here". */
  | { kind: 'ssh'; connectionId: string; provider: SshGitProvider | null }

export function runtimeGitRouteForTarget(target: RuntimeGitTarget): RuntimeGitRoute {
  const route = resolveGitRouteForHost(target.executionHostId)
  switch (route.kind) {
    case 'local':
      return { kind: 'local' }
    case 'ssh':
      return { kind: 'ssh', connectionId: route.connectionId, provider: route.provider }
    case 'runtime':
      throw new ExecutionHostNotDispatchableError(route.hostId)
  }
}

/**
 * `null` means exactly one thing: the host is `local`, and this command runs here as free
 * functions. An unreachable SSH host and a `runtime:` host both throw.
 */
export function requireRuntimeGitProvider(target: RuntimeGitTarget): SshGitProvider | null {
  const route = runtimeGitRouteForTarget(target)
  if (route.kind === 'local') {
    return null
  }
  if (!route.provider) {
    throw new Error(SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE)
  }
  return route.provider
}

export function localGitOptionsForTarget(target: RuntimeGitTarget): GitRuntimeOptions {
  // WSL routing describes *this* machine; no remote host may inherit it.
  return target.executionHostId === LOCAL_EXECUTION_HOST_ID ? (target.localGitOptions ?? {}) : {}
}

export function normalizeRuntimeGitRelativePath(filePath: string): string {
  const relativePath = normalizeRuntimeRelativePath(filePath)
  if (relativePath === '') {
    // Why: an empty Git pathspec can mutate the whole worktree.
    throw new Error('invalid_relative_path')
  }
  return relativePath
}
