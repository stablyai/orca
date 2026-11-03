import { PLUGIN_HOOK_SPECS } from '../../../shared/plugins/events/plugin-hook-payloads'
import { shortPluginBranchName } from '../../../shared/plugins/events/plugin-events'
import { isFolderRepo } from '../../../shared/repo-kind'
import type { Repo } from '../../../shared/repo-types'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
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

/**
 * Folder workspaces in a project group (`folderWorkspace.create`, agent launches into a new
 * folder, the window's create): one before/create/after boundary around the store write.
 */
export async function createFolderWorkspaceWithPluginHooks<
  Input extends { projectGroupId: string; name?: string },
  Workspace extends { id: string; folderPath: string }
>(input: Input, create: (input: Input) => Workspace): Promise<Workspace> {
  let request = input
  const requestedName = input.name?.trim()
  if (pluginHookWanted('workspace.create.before')) {
    const decided = await runPluginHook(
      'workspace.create.before',
      PLUGIN_HOOK_SPECS['workspace.create.before'].payload,
      { kind: 'folder', projectId: input.projectGroupId, name: requestedName || 'workspace' }
    )
    // Why compare: an unnamed request keeps Orca's default name unless a plugin chose one.
    if (requestedName || decided.name !== 'workspace') {
      request = { ...input, name: decided.name }
    }
  }
  const workspace = create(request)
  notifyWorkspaceCreatedPluginHook({
    worktreeId: folderWorkspaceKey(workspace.id),
    path: workspace.folderPath,
    branch: '',
    folder: true
  })
  return workspace
}
