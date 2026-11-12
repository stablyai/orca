import { worktreeRemovalReplyTimeoutMs } from '../../shared/worktree/archive-hook-removal-gate'
import type { RuntimeStatus } from '../../shared/runtime-session-contracts'
import type {
  RuntimeWorktreeRecord,
  RuntimeWorktreeRemoveResult,
  RuntimeWorktreeSetResult
} from '../../shared/runtime-worktree-contracts'
import type { FolderWorkspace } from '../../shared/folder-workspaces/folder-workspace-types'
import {
  FOLDER_WORKSPACE_UNIQUE_ID_MUTATION_RUNTIME_CAPABILITY,
  PROJECT_GROUP_FOLDER_SETUP_RUNTIME_CAPABILITY
} from '../../shared/worktree-runtime-capabilities'
import { folderIdOfSelector, folderWorkspaceKey } from '../../shared/workspace-scope'
import { formatWorktreeShow } from './workspace-format'
import { printResult } from '../output/command-result-output'
import { getOptionalStringFlag, getOptionalStringFlagAllowingEmpty } from '../arguments/flags'
import { RuntimeClientError } from '../runtime/types'
import type { RuntimeClient } from '../runtime/client'
import type { RuntimeRpcSuccess } from '../../shared/runtime-rpc-envelope'
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

async function showFolderWorkspace(
  client: RuntimeClient,
  folderId: string
): Promise<RuntimeRpcSuccess<{ worktree: RuntimeWorktreeRecord }>> {
  return client.call<{ worktree: RuntimeWorktreeRecord }>('worktree.show', {
    worktree: folderWorkspaceKey(folderId),
    matchFolderWorkspaces: true
  })
}

/** Older Orcas edit the first folder that shares an id and delete every one, so they are refused before any change. */
async function assertUniqueIdMutationSupported(client: RuntimeClient): Promise<void> {
  const status = await client.call<RuntimeStatus>('status.get')
  if (
    !status.result.capabilities?.includes(FOLDER_WORKSPACE_UNIQUE_ID_MUTATION_RUNTIME_CAPABILITY)
  ) {
    throw new RuntimeClientError(
      'incompatible_runtime',
      'This Orca cannot change folder workspaces from the CLI safely. Update Orca on the computer that owns the folder workspace. Nothing was changed.'
    )
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
  await assertUniqueIdMutationSupported(client)
  const updated = await client.call<{ folderWorkspace: FolderWorkspace | null }>(
    'folderWorkspace.update',
    {
      folderWorkspaceId: folderId,
      requireUniqueId: true,
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
  return showFolderWorkspace(client, folderId)
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
  const noGit = 'does not apply: a folder workspace has no branch.'
  refuseFolderFlags(flags, [['delete-branch', noGit]])
  await assertUniqueIdMutationSupported(client)
  const runHooks = flags.get('run-hooks') === true
  const allowFailedArchiveHook = flags.get('allow-failed-archive-hook') === true
  if (allowFailedArchiveHook && !runHooks) {
    throw new RuntimeClientError(
      'invalid_argument',
      '--allow-failed-archive-hook needs --run-hooks. Pass both, or drop the waiver.'
    )
  }
  const status = await client.call<RuntimeStatus>('status.get')
  const supported =
    status.result.capabilities?.includes(PROJECT_GROUP_FOLDER_SETUP_RUNTIME_CAPABILITY) === true
  if (!supported && (runHooks || allowFailedArchiveHook)) {
    throw new RuntimeClientError(
      'incompatible_runtime',
      'Update Orca on the workspace host to run group archive scripts. Nothing was changed.'
    )
  }
  const removal = await client.call<{ deleted: boolean }>(
    'folderWorkspace.delete',
    {
      folderWorkspaceId: folderId,
      requireUniqueId: true,
      ...(supported ? { runHooks, allowFailedArchiveHook } : {})
    },
    { timeoutMs: worktreeRemovalReplyTimeoutMs(runHooks) }
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
