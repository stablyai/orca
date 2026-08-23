import { lstat, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'
import { isGitRepo } from './repo'
import { gitExecFileAsync } from './runner'
import {
  convertStepLabel,
  GIT_IDENTITY_NOT_CONFIGURED_MESSAGE,
  initGitRepoInExistingFolder
} from './convert-folder-to-git'

export type LocalFolderGitConversionResult = { ok: true } | { ok: false; error: string }

// Why: IPC and runtime RPC can target the same local path concurrently; one
// shared lock prevents a failed attempt from cleaning up another attempt's repo.
const localConversionsInFlight = new Set<string>()

async function localPathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      (error as NodeJS.ErrnoException).code === 'ENOENT'
    ) {
      return false
    }
    throw error
  }
}

async function writeGitignoreExclusive(path: string, content: string): Promise<void> {
  try {
    await writeFile(path, content, { encoding: 'utf8', flag: 'wx' })
  } catch (error) {
    const code =
      error && typeof error === 'object' && 'code' in error
        ? (error as NodeJS.ErrnoException).code
        : undefined
    if (code !== 'EEXIST') {
      throw error
    }
  }
}

export async function convertLocalFolderToGit(
  path: string
): Promise<LocalFolderGitConversionResult> {
  if (path.trim().length === 0) {
    return { ok: false, error: 'Folder path is required' }
  }
  if (!isAbsolute(path)) {
    return { ok: false, error: 'Folder path must be an absolute path' }
  }

  const lockKey = normalizeRuntimePathForComparison(path)
  if (localConversionsInFlight.has(lockKey)) {
    return { ok: false, error: 'A conversion is already in progress for this folder.' }
  }
  localConversionsInFlight.add(lockKey)

  try {
    if (isGitRepo(path)) {
      return { ok: true }
    }

    const gitMetadataPath = join(path, '.git')
    const gitMetadataExisted = await localPathExists(gitMetadataPath)
    const gitignorePath = join(path, '.gitignore')
    const outcome = await initGitRepoInExistingFolder({
      exec: async (gitArgs) => {
        await gitExecFileAsync(gitArgs, { cwd: path })
      },
      hasGitignore: () => localPathExists(gitignorePath),
      writeGitignore: (content) => writeGitignoreExclusive(gitignorePath, content)
    })

    if (outcome.ok) {
      return outcome
    }

    const outcomeError = outcome.isIdentityError
      ? GIT_IDENTITY_NOT_CONFIGURED_MESSAGE
      : `${convertStepLabel(outcome.step)}: ${outcome.message}`
    let cleanupError: string | undefined
    // Why: git init can leave partial metadata when it fails; only preserve a
    // .git path that existed before this conversion attempt.
    if (!gitMetadataExisted) {
      await rm(gitMetadataPath, { recursive: true, force: true }).catch((error) => {
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
    localConversionsInFlight.delete(lockKey)
  }
}
