import { PLUGIN_HOOK_SPECS } from '../../../shared/plugins/events/plugin-hook-payloads'
import { shortPluginBranchName } from '../../../shared/plugins/events/plugin-events'
import { isFolderRepo } from '../../../shared/repo-kind'
import type { Repo } from '../../../shared/repo-types'
import { notifyPluginHook, pluginHookWanted, runPluginHook } from './plugin-hook-dispatch'

type WorkspaceCreateRequest = { name: string; branchNameOverride?: string; baseBranch?: string }

/**
 * `workspace.create.before`: the request Orca should create, as plugins changed it. Runs before
 * anything is created or sent to an SSH host; throws PluginHookDeniedError on a deny.
 */
export async function applyWorkspaceCreatePluginHook<Request extends WorkspaceCreateRequest>(
  request: Request,
  repo: Pick<Repo, 'id' | 'kind'>
): Promise<Request> {
  if (!pluginHookWanted('workspace.create.before')) {
    return request
  }
  const folder = isFolderRepo(repo)
  const decided = await runPluginHook(
    'workspace.create.before',
    PLUGIN_HOOK_SPECS['workspace.create.before'].payload,
    {
      kind: folder ? 'folder' : 'worktree',
      projectId: repo.id,
      name: request.name,
      ...(!folder && request.branchNameOverride ? { branch: request.branchNameOverride } : {}),
      ...(!folder && request.baseBranch ? { base: request.baseBranch } : {})
    }
  )
  // A cleared `branch` or `base` means Orca's default, as when the request left it out.
  return folder
    ? { ...request, name: decided.name }
    : {
        ...request,
        name: decided.name,
        branchNameOverride: decided.branch,
        baseBranch: decided.base
      }
}

/** `workspace.create.after`, folders included; Orca does not wait for it. */
export function notifyWorkspaceCreatedPluginHook(event: {
  worktreeId: string
  path: string
  branch: string
  folder: boolean
}): void {
  notifyPluginHook('workspace.create.after', {
    workspaceId: event.worktreeId,
    kind: event.folder ? 'folder' : 'worktree',
    path: event.path,
    branch: event.folder ? '' : shortPluginBranchName(event.branch)
  })
}
