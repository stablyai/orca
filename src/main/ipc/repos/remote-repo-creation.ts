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
import { resolveRemoteHomePath } from './remote-home-path'

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
  } catch {
    targetExists = false
  }

  if (targetExists) {
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
      if (createdDir) {
        await fsProvider.deletePath(targetPath, true).catch(() => undefined)
      } else if (step === 'commit') {
        await fsProvider
          .deletePath(joinRemotePath(host, targetPath, '.git'), true)
          .catch(() => undefined)
      }
      const message = err instanceof Error ? err.message : String(err)
      if (step === 'commit' && /Please tell me who you are|user\.name|user\.email/i.test(message)) {
        return {
          error:
            'Git author identity is not configured on the SSH host. Run `git config --global user.name "Your Name"` and `git config --global user.email "you@example.com"` on that host, then try again.'
        }
      }
      const stepLabel =
        step === 'init' ? 'Failed to initialize git repository' : 'Failed to create initial commit'
      return { error: `${stepLabel}: ${message}` }
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
