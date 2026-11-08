import type {
  RuntimeWorktreeRecord,
  RuntimeWorktreeRemoveResult,
  RuntimeWorktreeSetResult
} from '../../shared/runtime-types'
import type { FolderWorkspace } from '../../shared/folder-workspaces/folder-workspace-types'
import { folderIdOfSelector, folderWorkspaceKey } from '../../shared/workspace-scope'
import { formatWorktreeShow, printResult } from '../format'
import { getOptionalStringFlag, getOptionalStringFlagAllowingEmpty } from '../flags'
import { RuntimeClientError, type RuntimeClient, type RuntimeRpcSuccess } from '../runtime-client'
import { getWorktreeReadFlags } from './worktree-unread-flag'

type Flags = Map<string, string | boolean>

const LINK_FLAGS = ['issue', 'pr', 'linear-issue', 'gitlab-issue', 'gitlab-mr'] as const

/** Refuses, before any request, a flag that has no folder workspace meaning. */
function refuseFolderFlags(flags: Flags, refusals: readonly [string, string][]): void {
  const refused = refusals.find(([flag]) => flags.has(flag))
  if (refused) {
    throw new RuntimeClientError('invalid_argument', `--${refused[0]} ${refused[1]}`)
  }
}

/** The runtime refuses a folder id that several folder workspaces share, so nothing below acts on the wrong copy. */
async function showUniqueFolderWorkspace(
  client: RuntimeClient,
  folderId: string
): Promise<RuntimeRpcSuccess<{ worktree: RuntimeWorktreeRecord }>> {
  return client.call<{ worktree: RuntimeWorktreeRecord }>('worktree.show', {
    worktree: folderWorkspaceKey(folderId),
    matchFolderWorkspaces: true
  })
}

async function callFolderWorkspaceMethod<TResult>(
  client: RuntimeClient,
  method: 'folderWorkspace.update' | 'folderWorkspace.delete',
  params: unknown
): Promise<RuntimeRpcSuccess<TResult>> {
  try {
    return await client.call<TResult>(method, params)
  } catch (error) {
    if (error instanceof RuntimeClientError && error.code === 'method_not_found') {
      throw new RuntimeClientError(
        'incompatible_runtime',
        'This Orca cannot change folder workspaces from the CLI. Update Orca on the computer that owns the folder workspace. Nothing was changed.'
      )
    }
    throw error
  }
}

function folderGone(folderId: string): RuntimeClientError {
  return new RuntimeClientError(
    'selector_not_found',
    `Folder workspace ${folderWorkspaceKey(folderId)} no longer exists. Run orca worktree ps --json to list workspaces.`
  )
}

/** `worktree set` on a folder workspace, through the folder workspace update RPC. False for any other selector. */
export async function setIfFolderWorkspace(
  client: RuntimeClient,
  flags: Flags,
  selector: string,
  json: boolean
): Promise<boolean> {
  const folderId = folderIdOfSelector(selector)
  if (folderId === undefined) {
    return false
  }
  printResult(await setFolderWorkspace(client, flags, folderId), json, formatWorktreeShow)
  return true
}

async function setFolderWorkspace(
  client: RuntimeClient,
  flags: Flags,
  folderId: string
): Promise<RuntimeRpcSuccess<RuntimeWorktreeSetResult>> {
  const key = folderWorkspaceKey(folderId)
  refuseFolderFlags(flags, [
    [
      'parent-worktree',
      `does not apply: a folder workspace cannot have a parent. To nest a worktree under it, run orca worktree set --worktree <child> --parent-worktree ${key}.`
    ],
    ['no-parent', 'does not apply: a folder workspace never has a parent.'],
    ...LINK_FLAGS.map((flag): [string, string] => [
      flag,
      `does not apply to a folder workspace. Link it with orca reference add <url> --worktree ${key}.`
    ])
  ])
  const displayName = getOptionalStringFlag(flags, 'display-name')
  const comment = getOptionalStringFlagAllowingEmpty(flags, 'comment')
  const workspaceStatus = getOptionalStringFlag(flags, 'workspace-status')
  const { isUnread } = getWorktreeReadFlags(flags)
  await showUniqueFolderWorkspace(client, folderId)
  const updated = await callFolderWorkspaceMethod<{ folderWorkspace: FolderWorkspace | null }>(
    client,
    'folderWorkspace.update',
    {
      folderWorkspaceId: folderId,
      updates: {
        ...(displayName !== undefined ? { name: displayName } : {}),
        ...(comment !== undefined ? { comment } : {}),
        ...(workspaceStatus !== undefined ? { workspaceStatus } : {}),
        ...(isUnread !== undefined ? { isUnread } : {})
      }
    }
  )
  if (!updated.result.folderWorkspace) {
    throw folderGone(folderId)
  }
  return showUniqueFolderWorkspace(client, folderId)
}

/** `worktree rm` on a folder workspace: Orca forgets it; the folder stays on disk. False for any other selector. */
export async function removeIfFolderWorkspace(
  client: RuntimeClient,
  flags: Flags,
  selector: string,
  json: boolean
): Promise<boolean> {
  const folderId = folderIdOfSelector(selector)
  if (folderId === undefined) {
    return false
  }
  printResult(
    await removeFolderWorkspace(client, flags, folderId),
    json,
    () => 'removed: true\nOrca no longer lists this folder workspace; the folder stays on disk.'
  )
  return true
}

async function removeFolderWorkspace(
  client: RuntimeClient,
  flags: Flags,
  folderId: string
): Promise<RuntimeRpcSuccess<RuntimeWorktreeRemoveResult>> {
  const noGit = 'does not apply: a folder workspace has no branch or archive hooks.'
  refuseFolderFlags(flags, [
    ['delete-branch', noGit],
    ['run-hooks', noGit],
    ['allow-failed-archive-hook', noGit]
  ])
  await showUniqueFolderWorkspace(client, folderId)
  const removal = await callFolderWorkspaceMethod<{ deleted: boolean }>(
    client,
    'folderWorkspace.delete',
    { folderWorkspaceId: folderId }
  )
  if (!removal.result.deleted) {
    throw folderGone(folderId)
  }
  return { ...removal, result: { removed: true } }
}

export function refuseFolderWorkspaceActivation(folderId: string): never {
  throw new RuntimeClientError(
    'invalid_argument',
    `Activating a folder workspace from the CLI is not supported yet. Open it from the Orca sidebar, or inspect it with orca worktree show --worktree ${folderWorkspaceKey(folderId)} --json.`
  )
}
