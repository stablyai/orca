import type { Store } from '../../persistence'
import type { Repo } from '../../../shared/repo-types'
import {
  isRuntimePathAbsolute,
  normalizeRuntimePathForComparison,
  relativePathInsideRoot
} from '../../../shared/cross-platform-path'
import { getSshGitProvider } from '../../providers/ssh-git-dispatch'
import { getSshFilesystemProvider } from '../../providers/ssh-filesystem-dispatch'
import { joinRemotePath } from '../../ssh/ssh-remote-platform'
import { emitRepoAdded } from './repo-added-telemetry'
import { addRemoteRepoFromPath } from './remote-repo-registration'
import {
  alreadyARepositoryError,
  LEFTOVER_GIT_DIR_RETRY_HINT,
  repositoryCheckUnavailableError
} from './repository-creation-messages'
import { resolveRemoteHomePath } from './remote-home-path'
import { describeError, isNotADirectory, isProvenAbsent } from './proven-absence'

export async function createRemoteRepo(
  store: Store,
  args: {
    connectionId: string
    parentPath: string
    name: string
    kind: 'git' | 'folder'
  }
): Promise<{ repo: Repo } | { error: string }> {
  const name = args.name?.trim() ?? ''
  const parentPath = await resolveRemoteHomePath(args.connectionId, args.parentPath?.trim() ?? '')
  const repoKind: 'git' | 'folder' = args.kind === 'folder' ? 'folder' : 'git'
  if (!name) {
    return { error: 'Name cannot be empty' }
  }
  if (/[\\/]/.test(name) || name === '.' || name === '..') {
    return { error: 'Name cannot contain slashes or be "." / ".."' }
  }
  if (!parentPath) {
    return { error: 'Parent directory is required' }
  }
  const gitProvider = getSshGitProvider(args.connectionId)
  const fsProvider = getSshFilesystemProvider(args.connectionId)
  if (!gitProvider || !fsProvider) {
    return { error: `SSH connection "${args.connectionId}" not found or not connected` }
  }
  const host = gitProvider.getHostPlatform?.()
  if (!host) {
    return { error: 'SSH host platform is unavailable. Reconnect the SSH target before creating.' }
  }
  if (!isRuntimePathAbsolute(parentPath, host.pathFlavor)) {
    return { error: 'Parent directory must be an absolute path on the SSH host' }
  }

  const targetPath = joinRemotePath(host, parentPath, name)
  if (relativePathInsideRoot(parentPath, targetPath) === null) {
    return { error: 'Project path must be inside the parent directory' }
  }
  const targetPathKey = normalizeRuntimePathForComparison(targetPath)
  const existing = store.getRepos().find((repo) => {
    return (
      repo.connectionId === args.connectionId &&
      normalizeRuntimePathForComparison(repo.path) === targetPathKey
    )
  })
  if (existing) {
    emitRepoAdded('folder_picker', true)
    return { repo: existing }
  }

  let createdDir = false
  let targetExists = false
  try {
    await fsProvider.stat(targetPath)
    targetExists = true
  } catch (err) {
    // Why: only a proven ENOENT means absent. EACCES, ELOOP, a relay timeout or a disconnect say
    // nothing about the target, and must not become permission to create into it.
    if (!isProvenAbsent(err)) {
      return { error: repositoryCheckUnavailableError(name, describeError(err)) }
    }
    targetExists = false
  }

  if (targetExists) {
    // Why: refuse an existing repository on positive evidence, before `git init` can silently
    // reinitialize it. A `.git` FILE counts — that is how linked worktrees and submodules point.
    // This does not rely on readDir listing dotfiles, which the provider contract does not promise.
    try {
      await fsProvider.stat(joinRemotePath(host, targetPath, '.git'))
      return { error: alreadyARepositoryError(name) }
    } catch (err) {
      // Why: a file at the target is a definite answer, and the local lane already words it this
      // way — don't report a deterministic collision as an unavailable probe.
      if (isNotADirectory(err)) {
        return { error: `"${name}" already exists at this location and is not a folder.` }
      }
      // Why: same rule as above — an indeterminate probe is not evidence that `.git` is absent.
      if (!isProvenAbsent(err)) {
        return { error: repositoryCheckUnavailableError(name, describeError(err)) }
      }
    }
    try {
      const entries = await fsProvider.readDir(targetPath)
      if (entries.length > 0) {
        return { error: `"${name}" already exists at this location and is not empty.` }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { error: `Failed to read directory: ${message}` }
    }
  } else {
    try {
      await fsProvider.createDirNoClobber(targetPath)
      createdDir = true
    } catch (err) {
      const raceWinner = store.getRepos().find((repo) => {
        return (
          repo.connectionId === args.connectionId &&
          normalizeRuntimePathForComparison(repo.path) === targetPathKey
        )
      })
      if (raceWinner) {
        return { repo: raceWinner }
      }
      const message = err instanceof Error ? err.message : String(err)
      return { error: `Failed to create directory: ${message}` }
    }
  }

  if (repoKind === 'git') {
    let step: 'init' | 'commit' = 'init'
    try {
      await gitProvider.exec(['init'], targetPath)
      step = 'commit'
      await gitProvider.exec(['commit', '--allow-empty', '-m', 'Initial commit'], targetPath)
    } catch (err) {
      // Why: only the exclusive createDirNoClobber proves we made this; `git init` is idempotent and
      // never reports whether it created or reinitialized, so a .git here may not be ours to delete.
      let targetRemoved = false
      if (createdDir) {
        targetRemoved = await fsProvider
          .deletePath(targetPath, true)
          .then(() => true)
          .catch(() => false)
      }
      // Why: `git init` is not atomic either — a failed init can leave a partial .git — and
      // whatever remains makes the folder non-empty, so a silent retry would hit the
      // "not empty" guard with no clue why.
      const leftover = !targetRemoved ? ` ${LEFTOVER_GIT_DIR_RETRY_HINT}` : ''
      const message = err instanceof Error ? err.message : String(err)
      if (step === 'commit' && /Please tell me who you are|user\.name|user\.email/i.test(message)) {
        const identityHint =
          'Git author identity is not configured on the SSH host. Run `git config --global user.name "Your Name"` and `git config --global user.email "you@example.com"` on that host, then try again.'
        return { error: `${identityHint}${leftover}` }
      }
      const stepLabel =
        step === 'init' ? 'Failed to initialize git repository' : 'Failed to create initial commit'
      return { error: `${stepLabel}: ${message}${leftover}` }
    }
  }

  const raceWinner = store.getRepos().find((repo) => {
    return (
      repo.connectionId === args.connectionId &&
      normalizeRuntimePathForComparison(repo.path) === targetPathKey
    )
  })
  if (raceWinner) {
    emitRepoAdded('folder_picker', true)
    return { repo: raceWinner }
  }

  const result = await addRemoteRepoFromPath(store, {
    connectionId: args.connectionId,
    remotePath: targetPath,
    kind: repoKind,
    displayName: name
  })
  if ('error' in result) {
    return result
  }
  emitRepoAdded('folder_picker', result.alreadyExisted)
  return { repo: result.repo }
}
