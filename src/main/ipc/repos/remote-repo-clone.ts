import type { BrowserWindow } from 'electron'
import type { Store } from '../../persistence'
import type { Repo } from '../../../shared/repo-types'
import { isFolderRepo } from '../../../shared/repo-kind'
import {
  isRuntimePathAbsolute,
  normalizeRuntimePathForComparison,
  relativePathInsideRoot
} from '../../../shared/cross-platform-path'
import { getGitCloneFailureMessage } from '../../../shared/git-clone-failure-message'
import { deriveCloneRepoNameFromUrl } from '../../git/repo-clone-path'
import { getSshGitProvider } from '../../providers/ssh-git-dispatch'
import { getSshFilesystemProvider } from '../../providers/ssh-filesystem-dispatch'
import { joinRemotePath } from '../../ssh/ssh-remote-platform'
import { getActiveMultiplexer } from '../ssh'
import { emitRepoAdded } from './repo-added-telemetry'
import { addRemoteRepoFromPath } from './remote-repo-registration'
import { resolveRemoteHomePath } from './remote-home-path'

type ActiveRemoteCloneMetadata = {
  connectionId: string
  clonePath: string
  controller: AbortController
}

let activeRemoteClone: ActiveRemoteCloneMetadata | null = null
const remoteCloneInFlightByPath = new Set<string>()

export async function cloneRemoteRepo(
  store: Store,
  mainWindow: BrowserWindow,
  args: {
    connectionId: string
    url: string
    destination: string
  }
): Promise<Repo> {
  const gitProvider = getSshGitProvider(args.connectionId)
  if (!gitProvider) {
    throw new Error(`SSH connection "${args.connectionId}" not found or not connected`)
  }
  const fsProvider = getSshFilesystemProvider(args.connectionId)
  if (!fsProvider) {
    throw new Error(`SSH connection "${args.connectionId}" not found or not connected`)
  }
  const host = gitProvider.getHostPlatform?.()
  if (!host) {
    throw new Error('SSH host platform is unavailable. Reconnect the SSH target before cloning.')
  }
  const trimmedDestination = await resolveRemoteHomePath(args.connectionId, args.destination.trim())
  if (!isRuntimePathAbsolute(trimmedDestination, host.pathFlavor)) {
    throw new Error('Clone destination must be an absolute path on the SSH host')
  }
  const repoName = deriveCloneRepoNameFromUrl(args.url.trim())
  const clonePath = joinRemotePath(host, trimmedDestination, repoName)
  if (relativePathInsideRoot(trimmedDestination, clonePath) === null) {
    throw new Error('Clone path must be inside the destination directory')
  }
  const clonePathKey = normalizeRuntimePathForComparison(clonePath)
  const existing = store.getRepos().find((repo) => {
    return (
      repo.connectionId === args.connectionId &&
      normalizeRuntimePathForComparison(repo.path) === clonePathKey
    )
  })
  if (existing && !isFolderRepo(existing)) {
    emitRepoAdded('clone_url', true)
    return existing
  }

  const remoteCloneKey = `${args.connectionId}:${clonePathKey}`
  if (remoteCloneInFlightByPath.has(remoteCloneKey)) {
    throw new Error('A clone is already in progress for this SSH destination')
  }
  const controller = new AbortController()
  const metadata: ActiveRemoteCloneMetadata = {
    connectionId: args.connectionId,
    clonePath,
    controller
  }
  activeRemoteClone = metadata
  remoteCloneInFlightByPath.add(remoteCloneKey)
  try {
    // Why: match local clone by creating the parent first, or a fresh remote parent surfaces as spawn ENOENT.
    await fsProvider.createDir(trimmedDestination)
    // Why: the SSH relay runs git argv, not a shell; use the repo folder name so git creates it under the chosen parent.
    await gitProvider.clone(
      ['clone', '--progress', '--', args.url.trim(), repoName],
      trimmedDestination,
      {
        signal: controller.signal,
        timeoutMs: 10 * 60_000,
        onProgress: (progress) => {
          if (!mainWindow.isDestroyed()) {
            mainWindow.webContents.send('repos:clone-progress', progress)
          }
        }
      }
    )
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error('Clone aborted')
    }
    const message = err instanceof Error ? err.message : String(err)
    if (message.startsWith('Clone failed:')) {
      throw new Error(`Clone failed: ${getGitCloneFailureMessage(message, { clonePath })}`)
    }
    throw err
  } finally {
    if (activeRemoteClone === metadata) {
      activeRemoteClone = null
    }
    remoteCloneInFlightByPath.delete(remoteCloneKey)
  }
  if (existing && isFolderRepo(existing)) {
    const updated = store.updateRepo(existing.id, {
      kind: 'git',
      projectHostSetupMethod: 'cloned'
    })
    if (updated) {
      emitRepoAdded('clone_url', false)
      getActiveMultiplexer(args.connectionId)?.notify('session.registerRoot', {
        rootPath: clonePath
      })
      return updated
    }
  }
  const result = await addRemoteRepoFromPath(store, {
    connectionId: args.connectionId,
    remotePath: clonePath,
    kind: 'git',
    setupMethod: 'cloned'
  })
  if ('error' in result) {
    throw new Error(result.error)
  }
  emitRepoAdded('clone_url', result.alreadyExisted)
  return result.repo
}

// Why: `activeRemoteClone` is module-scoped and cannot be reassigned across a module boundary.
export function abortActiveRemoteClone(): void {
  if (activeRemoteClone) {
    activeRemoteClone.controller.abort()
    activeRemoteClone = null
  }
}
