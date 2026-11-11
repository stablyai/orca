import type { Repo } from '../../../../shared/repo-types'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { CreateWorktreeResult } from '../../../../shared/worktree/create-types'
import type { WorktreeMeta } from '../../../../shared/worktree/meta-types'
import { createRuntimePerforceCopy } from '../../runtime-perforce-copy-commands'
import { invalidateAuthorizedRootsCache } from '../../../ipc/worktrees/removal/registered-worktree-roots-cache'
import type { RuntimeManagedWorktreeCreateArgs } from './runtime-managed-worktree-create-types'

export type RuntimeFolderPerforceCopy = {
  worktreeId: string
  /** Metadata the copy's workspace records beside the folder-workspace defaults. */
  meta: Partial<WorktreeMeta>
  /** Call after the meta write: a copy's folder is an authorized root only once it is recorded. */
  recorded: () => void
  result: Pick<CreateWorktreeResult, 'perforceCopy'>
}

/**
 * "Create workspace" in a Perforce project makes a copy on its own stream instead of sharing the
 * folder. Null when the request asked for no copy.
 */
// Why a separate module: the folder create sits at the .ts max-lines limit upstream.
export async function createRuntimeFolderPerforceCopy(
  repo: Repo,
  request: RuntimeManagedWorktreeCreateArgs,
  settings: { perforce?: GlobalSettings['perforce'] }
): Promise<RuntimeFolderPerforceCopy | null> {
  if (!request.perforceCopy) {
    return null
  }
  const copy = await createRuntimePerforceCopy(
    repo,
    { workspaceName: request.name, ...request.perforceCopy },
    settings
  )
  return {
    worktreeId: copy.worktreeId,
    meta: { perforceStream: copy.summary.stream },
    recorded: invalidateAuthorizedRootsCache,
    result: { perforceCopy: copy.summary }
  }
}
