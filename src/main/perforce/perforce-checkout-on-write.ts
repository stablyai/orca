import { access, constants, lstat } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import type { Repo } from '../../shared/repo-types'
import { isFolderRepo } from '../../shared/repo-kind'
import { isPerforceWorkspace } from './perforce-detection'
import { editFiles } from './perforce-mutations'

function findContainingFolderRepo(repos: readonly Repo[], filePath: string): Repo | undefined {
  return repos.find((repo) => {
    if (repo.connectionId || !isFolderRepo(repo)) {
      return false
    }
    const rel = relative(repo.path, filePath)
    return rel !== '' && !rel.startsWith('..') && resolve(repo.path, rel) === resolve(filePath)
  })
}

/**
 * Perforce leaves synced files read-only until they are opened for edit, so saving one
 * would fail with EACCES. Check the file out first; any failure falls through to the normal write.
 */
export async function checkoutReadOnlyPerforceFileBeforeWrite(
  repos: readonly Repo[],
  filePath: string
): Promise<void> {
  const repo = findContainingFolderRepo(repos, filePath)
  if (!repo) {
    return
  }
  try {
    const stats = await lstat(filePath)
    if (!stats.isFile()) {
      return
    }
    await access(filePath, constants.W_OK).then(
      () => 'writable',
      async () => {
        if (await isPerforceWorkspace(repo.path)) {
          await editFiles(repo.path, [relative(repo.path, filePath)])
        }
      }
    )
  } catch {
    // Missing files and probe failures are the writer's to report.
  }
}
