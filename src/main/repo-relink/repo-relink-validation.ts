import { isAbsolute } from 'node:path'
import { isWindowsAbsolutePathLike } from '../../shared/cross-platform-path'
import { getRepoExecutionHostId, parseExecutionHostId } from '../../shared/execution-host'
import { isFolderRepo } from '../../shared/repo-kind'
import { formatRepoRelinkError, type RepoRelinkErrorCode } from '../../shared/repo-path-status'
import type { Repo } from '../../shared/repo-types'
import type { GitWorktreeInfo } from '../../shared/worktree/types'
import { runtimePathsEqual } from '../runtime/runtime-worktree-path-identity'
import type { RepoHostFilesystem } from './repo-host-filesystem'
import type { RepoRelinkHostGit } from './repo-relink-host-git'

/** What proved the folder is the registered repository, strongest first. */
export type RepoRelinkEvidence =
  | 'same-path'
  | 'path-alias'
  | 'shared-worktrees'
  | 'remote-identity'
  | 'forced'

export type RepoRelinkPlan = {
  repo: Repo
  oldPath: string
  newPath: string
  evidence: RepoRelinkEvidence
  /** `git worktree list` from the new location; empty when it could not be read. */
  gitWorktrees: GitWorktreeInfo[]
}

export type RepoRelinkValidationInput = {
  repo: Repo
  requestedPath: string
  /** Every registered repo, so a folder another project owns is refused. */
  registeredRepos: readonly Repo[]
  /** Linked worktree paths Orca holds state for under this repo id. */
  knownLinkedWorktreePaths: readonly string[]
  force: boolean
  fs: RepoHostFilesystem | null
  git: RepoRelinkHostGit
}

function refuse(code: RepoRelinkErrorCode, detail: string): never {
  throw new Error(formatRepoRelinkError(code, detail))
}

function isAbsoluteOnHost(path: string, repo: Repo): boolean {
  const kind = parseExecutionHostId(getRepoExecutionHostId(repo))?.kind
  // Why: SSH paths are POSIX on the host, whatever platform this client runs on.
  return kind === 'ssh' ? path.startsWith('/') : isAbsolute(path) || isWindowsAbsolutePathLike(path)
}

const UNREACHABLE_DETAIL =
  'Orca cannot reach the host that owns this repository. Reconnect and try again.'

async function resolveCheckoutRoot(input: RepoRelinkValidationInput): Promise<string> {
  const { fs, git, requestedPath } = input
  if (!fs) {
    refuse('repo_relink_host_unverifiable', UNREACHABLE_DETAIL)
  }
  const kind = await fs.inspectTarget(requestedPath)
  if (kind === 'unverifiable') {
    refuse('repo_relink_host_unverifiable', UNREACHABLE_DETAIL)
  }
  if (kind === 'absent') {
    refuse('repo_relink_path_not_found', `${requestedPath} does not exist.`)
  }
  if (kind !== 'directory') {
    refuse('repo_relink_path_not_directory', `${requestedPath} is not a folder.`)
  }
  const toplevel = await git.showToplevel(requestedPath)
  if (toplevel.kind === 'unverifiable') {
    refuse('repo_relink_host_unverifiable', UNREACHABLE_DETAIL)
  }
  if (toplevel.kind === 'not-repo') {
    refuse('repo_relink_not_git_toplevel', `${requestedPath} is not a Git repository.`)
  }
  // Git reports the physical top level, so compare against the resolved folder too.
  const canonical = (await fs.resolveRealPath(requestedPath)) ?? requestedPath
  if (
    !runtimePathsEqual(toplevel.path, canonical) &&
    !runtimePathsEqual(toplevel.path, requestedPath)
  ) {
    refuse(
      'repo_relink_not_git_toplevel',
      `${requestedPath} is inside the repository at ${toplevel.path}. Choose its top-level folder.`
    )
  }
  return toplevel.path
}

async function findIdentityEvidence(
  input: RepoRelinkValidationInput,
  newPath: string,
  gitWorktrees: readonly GitWorktreeInfo[]
): Promise<RepoRelinkEvidence | { refusal: RepoRelinkErrorCode; detail: string }> {
  const { repo, fs, git } = input
  // A symlink or alias left at the old path that resolves here is the same folder.
  const oldRealPath = fs ? await fs.resolveRealPath(repo.path) : null
  if (oldRealPath && runtimePathsEqual(oldRealPath, newPath)) {
    return 'path-alias'
  }
  // Git administers a linked worktree from exactly one common directory, so a listed one we know proves it.
  const linked = gitWorktrees.filter((worktree) => !worktree.isMainWorktree)
  if (
    linked.some((worktree) =>
      input.knownLinkedWorktreePaths.some((known) => runtimePathsEqual(known, worktree.path))
    )
  ) {
    return 'shared-worktrees'
  }
  const storedKey = repo.gitRemoteIdentity?.canonicalKey
  if (storedKey) {
    const remotes = await git.readRemoteKeys(newPath)
    if (remotes.kind === 'resolved' && remotes.keys.includes(storedKey)) {
      return 'remote-identity'
    }
    if (remotes.kind === 'resolved' && remotes.keys.length > 0) {
      return {
        refusal: 'repo_relink_different_repository',
        detail: `${newPath} has different remotes than ${repo.displayName} (${repo.gitRemoteIdentity?.remoteUrl ?? storedKey}).`
      }
    }
  }
  return {
    refusal: 'repo_relink_identity_unverified',
    detail: `Orca cannot confirm that ${newPath} is the same repository as ${repo.displayName}: no shared remote or linked worktree to compare.`
  }
}

/** Validates a relink target on the repo's own host; throws a coded refusal otherwise. */
export async function validateRepoRelinkTarget(
  input: RepoRelinkValidationInput
): Promise<RepoRelinkPlan> {
  const { repo, requestedPath } = input
  if (isFolderRepo(repo)) {
    refuse('repo_relink_folder_repo_unsupported', 'Only Git repositories can be relinked.')
  }
  if (!isAbsoluteOnHost(requestedPath, repo)) {
    refuse('repo_relink_path_not_absolute', `${requestedPath} is not an absolute path.`)
  }
  const newPath = await resolveCheckoutRoot(input)
  const hostId = getRepoExecutionHostId(repo)
  const owner = input.registeredRepos.find(
    (candidate) =>
      candidate.id !== repo.id &&
      getRepoExecutionHostId(candidate) === hostId &&
      runtimePathsEqual(candidate.path, newPath)
  )
  if (owner) {
    refuse('repo_relink_path_registered', `${owner.displayName} already uses ${newPath}.`)
  }
  const gitWorktrees = (await input.git.listWorktrees(newPath)) ?? []
  if (runtimePathsEqual(newPath, repo.path)) {
    return { repo, oldPath: repo.path, newPath, evidence: 'same-path', gitWorktrees }
  }
  const evidence = await findIdentityEvidence(input, newPath, gitWorktrees)
  if (typeof evidence !== 'string') {
    if (!input.force) {
      refuse(evidence.refusal, evidence.detail)
    }
    return { repo, oldPath: repo.path, newPath, evidence: 'forced', gitWorktrees }
  }
  return { repo, oldPath: repo.path, newPath, evidence, gitWorktrees }
}
