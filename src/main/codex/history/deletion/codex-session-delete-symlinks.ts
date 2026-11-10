import { constants } from 'node:fs'
import { copyFile, chmod, rename, rm, mkdtemp, realpath, unlink, rmdir } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import {
  assertCodexSessionDeletionPath,
  type CodexSessionDeletionStagingFile,
  type CodexSessionDeletionSymlink
} from './codex-session-delete-targets'
import { normalizeRuntimePathForComparison } from '../../../../shared/cross-platform-path'
import { readCodexRolloutSessionMetaId } from '../rollouts/codex-rollout-session-meta'

export async function materializeCodexSessionDeletionSymlinks(
  sessionId: string,
  aliases: readonly CodexSessionDeletionSymlink[],
  homes: readonly string[]
): Promise<void> {
  const visited = new Set<string>()
  for (const alias of aliases) {
    const key = normalizeRuntimePathForComparison(
      join(await realpath(dirname(alias.filePath)), basename(alias.filePath))
    )
    if (visited.has(key)) {
      continue
    }
    if (
      (await assertCodexSessionDeletionPath(alias.home, alias.filePath, homes)) !== alias.target
    ) {
      throw new Error('Codex session alias changed')
    }
    visited.add(key)
    const directory = await mkdtemp(join(dirname(alias.filePath), `.orca-delete-${sessionId}-`))
    const temporary = join(directory, basename(alias.filePath))
    try {
      if (
        (await assertCodexSessionDeletionPath(alias.home, alias.filePath, homes)) !== alias.target
      ) {
        throw new Error('Codex session alias changed')
      }
      await copyFile(alias.target, temporary, constants.COPYFILE_EXCL)
      await chmod(temporary, 0o600)
      if (
        (await readCodexRolloutSessionMetaId(temporary))?.toLowerCase() !== sessionId ||
        (await assertCodexSessionDeletionPath(alias.home, alias.filePath, homes)) !== alias.target
      ) {
        throw new Error('Codex session alias identity changed')
      }
      // Codex ignores symlink rollouts; a private copy lets its CLI remove the alias and index.
      await rename(temporary, alias.filePath)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }
}

export async function discardCodexSessionDeletionStagingFiles(
  files: readonly CodexSessionDeletionStagingFile[]
): Promise<void> {
  for (const { home, filePath } of files) {
    try {
      if ((await assertCodexSessionDeletionPath(home, filePath)) !== null) {
        throw new Error('Invalid Codex deletion staging file')
      }
      await unlink(filePath)
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
        throw error
      }
    }
    try {
      await rmdir(dirname(filePath))
    } catch (error) {
      if (
        !(
          error instanceof Error &&
          'code' in error &&
          (error.code === 'ENOENT' || error.code === 'ENOTEMPTY')
        )
      ) {
        throw error
      }
    }
  }
}
