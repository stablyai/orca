import { shell } from 'electron'
import type { Store } from '../persistence'
import type { GitHubDeleteClonedRepoFilesResult } from '../../shared/github-account'
import { getDefaultProjectsCloneParent } from '../../shared/clone-destination'
import { relativePathInsideRoot } from '../../shared/cross-platform-path'
import { isENOENT } from '../ipc/filesystem-path-containment'

// Cleanup for the GitHub panel: trash the on-disk clone, then the caller drops
// the project from Orca. The clone parent is recomputed here from settings —
// never taken from the renderer — so this handler can only trash directories
// Orca itself would clone into.
export async function deleteGitHubClonedRepoFiles(
  store: Store,
  repoId: string
): Promise<GitHubDeleteClonedRepoFilesResult> {
  const repo = store.getRepo(repoId)
  if (!repo) {
    return { ok: false, error: 'Project not found.' }
  }
  if (repo.projectHostSetupMethod !== 'cloned') {
    return { ok: false, error: 'Only repositories cloned through Orca can be cleaned up here.' }
  }
  const isLocal =
    repo.connectionId == null && (!repo.executionHostId || repo.executionHostId === 'local')
  if (!isLocal) {
    return { ok: false, error: 'Only local clones can be cleaned up here.' }
  }
  const cloneParent = getDefaultProjectsCloneParent(store.getSettings().workspaceDir ?? '')
  if (!cloneParent || relativePathInsideRoot(cloneParent, repo.path) === null) {
    return { ok: false, error: 'Repository files are outside the clone directory.' }
  }
  try {
    await shell.trashItem(repo.path)
  } catch (error) {
    // Files already gone (e.g. deleted externally): still let the project detach.
    if (isENOENT(error)) {
      return { ok: true }
    }
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
  return { ok: true }
}
