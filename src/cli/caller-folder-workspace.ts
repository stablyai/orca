import type { FolderWorkspace } from '../shared/folder-workspaces/folder-workspace-types'
import { getFolderSourceRepos } from '../shared/folder-workspaces/folder-workspace-source-repos'
import type { ProjectGroup } from '../shared/project-group-types'
import type { Repo } from '../shared/repo-types'
import { folderWorkspaceKey, parseWorkspaceKey, type WorkspaceKey } from '../shared/workspace-scope'
import { getOptionalStringFlag } from './flags'
import { RuntimeClientError, type RuntimeClient } from './runtime-client'
import { getOptionalWorktreeSelector } from './selectors'

export type FolderWorkspaceRepoChoice = {
  repo: string
  name: string
  path: string
}

/** The folder workspace whose terminal runs this command, from the env Orca sets on its terminals. */
export function getCallerFolderWorkspaceKey(): WorkspaceKey | undefined {
  return [process.env.ORCA_WORKSPACE_ID, process.env.ORCA_WORKTREE_ID]
    .map((id) => id?.trim())
    .find((id): id is WorkspaceKey => !!id && parseWorkspaceKey(id)?.type === 'folder')
}

/**
 * A parent flag's value. active/current follow the enclosing-workspace rule; outside every workspace a
 * folder terminal still names its own folder, which isn't a cwd the catalog can contain.
 */
export async function getOptionalParentSelector(
  flags: Map<string, string | boolean>,
  cwd: string,
  client: RuntimeClient
): Promise<string | undefined> {
  const value = getOptionalStringFlag(flags, 'parent-worktree')
  try {
    return await getOptionalWorktreeSelector(flags, 'parent-worktree', cwd, client)
  } catch (error) {
    // A worktree terminal's own workspace is a worktree; only folder terminals fall back to a folder.
    const callerWorktree = process.env.ORCA_WORKTREE_ID?.trim()
    const callerFolder =
      callerWorktree && !callerWorktree.startsWith('folder:')
        ? undefined
        : getCallerFolderWorkspaceKey()
    if (
      client.isRemote ||
      (value !== 'active' && value !== 'current') ||
      !callerFolder ||
      !(error instanceof RuntimeClientError) ||
      error.code !== 'selector_not_found'
    ) {
      throw error
    }
    return callerFolder
  }
}

async function readFolderWorkspaceRepos(
  client: RuntimeClient,
  folderKey: WorkspaceKey
): Promise<{ folderWorkspace: FolderWorkspace; repos: Repo[] } | undefined> {
  const parsed = parseWorkspaceKey(folderKey)
  if (parsed?.type !== 'folder') {
    return undefined
  }
  const [folders, groups, repos] = await Promise.all([
    client.call<{ folderWorkspaces: FolderWorkspace[] }>('folderWorkspace.list'),
    client.call<{ groups: ProjectGroup[] }>('projectGroup.list'),
    client.call<{ repos: Repo[] }>('repo.list', {})
  ])
  const folderWorkspace = folders.result.folderWorkspaces.find(
    (workspace) => workspace.id === parsed.folderWorkspaceId
  )
  if (!folderWorkspace) {
    return undefined
  }
  const group = groups.result.groups.find((entry) => entry.id === folderWorkspace.projectGroupId)
  return {
    folderWorkspace,
    repos: getFolderSourceRepos(repos.result.repos, groups.result.groups, group ?? null)
  }
}

/**
 * The refusal for a create with no repo from or under a folder workspace: the folder is not a Git
 * repository, so list the repositories it holds. The user's own command keeps every flag they typed.
 */
export async function getFolderWorkspaceMissingRepoError(
  client: RuntimeClient,
  flags: Map<string, string | boolean>,
  resolvedParentWorkspace: string | undefined
): Promise<RuntimeClientError | undefined> {
  const parsedParent = resolvedParentWorkspace ? parseWorkspaceKey(resolvedParentWorkspace) : null
  // With no parent flag, create attaches to the terminal's folder.
  const inferredFolder =
    !flags.has('parent-worktree') && flags.get('no-parent') !== true && !client.isRemote
      ? getCallerFolderWorkspaceKey()
      : undefined
  const folderKey =
    parsedParent?.type === 'folder'
      ? folderWorkspaceKey(parsedParent.folderWorkspaceId)
      : inferredFolder
  if (!folderKey) {
    return undefined
  }
  // Older hosts without these reads keep the generic refusal.
  const read = await readFolderWorkspaceRepos(client, folderKey).catch(() => undefined)
  if (!read) {
    return undefined
  }
  const choices: FolderWorkspaceRepoChoice[] = read.repos.map((repo) => ({
    repo: `id:${repo.id}`,
    name: repo.displayName,
    path: repo.path
  }))
  const data = { folderWorkspace: folderKey, repos: choices }
  if (choices.length === 0) {
    return new RuntimeClientError(
      'invalid_argument',
      `This folder workspace is not a Git repository, and Orca has no Git repositories registered under ${read.folderWorkspace.folderPath}. Add one with orca repo add --path <repository path>, then pass --repo.`,
      data
    )
  }
  const width = Math.max(...choices.map((choice) => choice.repo.length))
  const lines = choices.map(
    (choice) => `  --repo ${choice.repo.padEnd(width)}   # ${choice.name}  ${choice.path}`
  )
  return new RuntimeClientError(
    'invalid_argument',
    [
      'This folder workspace is not a Git repository. Add --repo to your command to choose which repository gets the worktree:',
      ...lines,
      'The new worktree attaches to this folder workspace and is shown in its Source Control and Attached worktrees panels.'
    ].join('\n'),
    data
  )
}
