import { randomUUID } from 'node:crypto'
import type { BrowserWindow } from 'electron'
import type { Repo } from '../../../../shared/repo-types'
import type { CreateWorktreeResult } from '../../../../shared/worktree/create-types'
import { resolveWorkspaceCopyBackend } from '../../../perforce/perforce-copy-backend'
import { createPerforceCopyForWorkspace } from '../../../perforce/perforce-copy-creation'
import {
  desktopPerforceSettings,
  runWithDesktopPerforceSettings
} from '../../../perforce/perforce-desktop-settings'
import type { Store } from '../../../persistence/loading-store/store'
import { requireWorktreeCreateRoute } from '../../../worktree-create-execution-host-route'
import {
  invalidateAuthorizedRootsCache,
  resolveRegisteredWorktreePath
} from '../../registered-worktree-roots-cache'
import { emitCreateWorktreeProgress } from '../../worktree-remote'
import { folderWorkspaceCreateMeta } from '../create/folder-workspace-creation'
import { mergeFolderWorkspace } from '../folder-workspace-model'
import type { CreateWorktreeArgsWithSystemProvenance } from '../ipc-context-schemas'

/**
 * "Use worktree" for a folder project in a Perforce stream workspace: the new workspace is a Perforce
 * copy named after it, with its own client, instead of a second session on the project folder.
 */
export function createPerforceCopyWorkspace(
  args: CreateWorktreeArgsWithSystemProvenance,
  repo: Repo,
  store: Store,
  mainWindow: BrowserWindow
): Promise<CreateWorktreeResult> {
  return runWithDesktopPerforceSettings(store, async () => {
    // Why: route like Git's create, since a row may name its SSH owner only in `executionHostId`.
    const route = requireWorktreeCreateRoute(repo)
    // SSH paths belong to the remote host; only local paths are checked against registered roots.
    const sourceDir =
      route.kind === 'ssh' ? repo.path : await resolveRegisteredWorktreePath(repo.path, store)
    const { worktreeId, summary } = await createPerforceCopyForWorkspace({
      backend: resolveWorkspaceCopyBackend(route.kind === 'ssh' ? route.connectionId : undefined),
      repo: route.kind === 'ssh' ? route.repo : repo,
      sourceDir,
      workspaceName: args.name,
      stream: args.perforceCopy?.stream,
      settings: desktopPerforceSettings(store),
      onProgress: (detail) =>
        emitCreateWorktreeProgress(mainWindow, 'creating', args.creationId, detail)
    })
    const meta = store.setWorktreeMeta(worktreeId, {
      instanceId: randomUUID(),
      ...folderWorkspaceCreateMeta(args, repo, store, Date.now()),
      perforceStream: summary.stream
    })
    invalidateAuthorizedRootsCache()
    return { worktree: mergeFolderWorkspace(repo, worktreeId, meta), perforceCopy: summary }
  })
}
