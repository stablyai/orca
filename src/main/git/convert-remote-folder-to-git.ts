import { randomUUID } from 'node:crypto'
import {
  isRuntimePathAbsolute,
  normalizeRuntimePathForComparison
} from '../../shared/cross-platform-path'
import type { IFilesystemProvider } from '../providers/types'
import type { IGitProvider } from '../providers/git-provider-contract'
import { joinRemotePath, type RemoteHostPlatform } from '../ssh/ssh-remote-platform'
import { convertStepLabel, initGitRepoInExistingFolder } from './convert-folder-to-git'

type RemoteGitConversionProvider = Pick<IGitProvider, 'exec' | 'isGitRepoAsync'>

export type RemoteFolderGitConversionResult =
  | { ok: true; repoPath: string }
  | { ok: false; error: string }

const remoteConversionsInFlight = new Set<string>()

async function remotePathExists(fsProvider: IFilesystemProvider, path: string): Promise<boolean> {
  try {
    await (fsProvider.lstat?.(path) ?? fsProvider.stat(path))
    return true
  } catch (error) {
    const code =
      error && typeof error === 'object' && 'code' in error
        ? (error as NodeJS.ErrnoException).code
        : undefined
    if (code === 'ENOENT') {
      return false
    }
    throw error
  }
}

// Why: remote writeFile has no exclusive-create flag, so a sibling temporary
// file plus renameNoClobber preserves a .gitignore created during the probe.
export async function writeGitignoreExclusiveRemote(
  fsProvider: IFilesystemProvider,
  tmpPath: string,
  gitignorePath: string,
  content: string
): Promise<void> {
  try {
    await fsProvider.writeFile(tmpPath, content)
    await fsProvider.renameNoClobber(tmpPath, gitignorePath)
  } catch (error) {
    await fsProvider.deletePath(tmpPath, false).catch(() => undefined)
    const code =
      error && typeof error === 'object' && 'code' in error
        ? (error as NodeJS.ErrnoException).code
        : undefined
    if (code !== 'EEXIST') {
      throw error
    }
  }
}

export async function convertRemoteFolderToGit(args: {
  connectionId: string
  path: string
  host: RemoteHostPlatform
  gitProvider: RemoteGitConversionProvider
  fsProvider: IFilesystemProvider
}): Promise<RemoteFolderGitConversionResult> {
  const { connectionId, path, host, gitProvider, fsProvider } = args
  if (path.trim().length === 0) {
    return { ok: false, error: 'Folder path is required' }
  }
  if (!isRuntimePathAbsolute(path, host.pathFlavor)) {
    return { ok: false, error: 'Folder path must be an absolute path on the SSH host' }
  }

  const lockKey = `${connectionId}:${normalizeRuntimePathForComparison(path)}`
  if (remoteConversionsInFlight.has(lockKey)) {
    return { ok: false, error: 'A conversion is already in progress for this folder.' }
  }
  remoteConversionsInFlight.add(lockKey)

  try {
    let existingRepo
    try {
      existingRepo = await gitProvider.isGitRepoAsync(path)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, error: `Failed to inspect folder on the SSH host: ${message}` }
    }
    if (existingRepo.isRepo) {
      return { ok: true, repoPath: existingRepo.rootPath ?? path }
    }

    const gitMetadataPath = joinRemotePath(host, path, '.git')
    const gitMetadataExisted = await remotePathExists(fsProvider, gitMetadataPath)
    const gitignorePath = joinRemotePath(host, path, '.gitignore')
    const gitignoreTmpPath = joinRemotePath(
      host,
      path,
      `.orca-gitignore-${Date.now()}-${randomUUID()}.tmp`
    )
    const outcome = await initGitRepoInExistingFolder({
      exec: async (gitArgs) => {
        await gitProvider.exec(gitArgs, path)
      },
      hasGitignore: () => remotePathExists(fsProvider, gitignorePath),
      writeGitignore: (content) =>
        writeGitignoreExclusiveRemote(fsProvider, gitignoreTmpPath, gitignorePath, content)
    })

    if (outcome.ok) {
      return { ok: true, repoPath: path }
    }

    const outcomeError = outcome.isIdentityError
      ? 'Git author identity is not configured on the SSH host. Run `git config --global user.name "Your Name"` and `git config --global user.email "you@example.com"` on that host, then try again.'
      : `${convertStepLabel(outcome.step)}: ${outcome.message}`
    let cleanupError: string | undefined
    // Why: git init can leave partial metadata when it fails; only preserve a
    // .git path that existed before this conversion attempt.
    if (!gitMetadataExisted) {
      await fsProvider.deletePath(gitMetadataPath, true).catch((error) => {
        cleanupError = error instanceof Error ? error.message : String(error)
      })
    }
    return {
      ok: false,
      error: cleanupError
        ? `${outcomeError}. Failed to remove partial Git metadata: ${cleanupError}`
        : outcomeError
    }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    }
  } finally {
    remoteConversionsInFlight.delete(lockKey)
  }
}
