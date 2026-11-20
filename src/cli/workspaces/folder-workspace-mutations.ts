import type { RuntimeStatus } from '../../shared/remote-runtime/session-graph/runtime-session-contracts'
import {
  archiveHookReport,
  formatArchiveHookLine,
  getArchiveHookChoice,
  printRemovalHookWarnings,
  resolveArchiveHookRequest,
  type ArchiveHookRequest
} from './worktree-archive-hook-choice'
import type {
  ArchiveHookApprovalRequest,
  ArchiveHookChoice,
  ArchiveHookReport
} from '../../shared/worktree/removal/archive-hook-decision'
import type {
  RuntimeWorktreeRecord,
  RuntimeWorktreeRemoveResult,
  RuntimeWorktreeSetResult
} from '../../shared/worktree/catalog/runtime-worktree-contracts'
import type { FolderWorkspace } from '../../shared/folder-workspaces/folder-workspace-types'
import {
  FOLDER_WORKSPACE_UNIQUE_ID_MUTATION_RUNTIME_CAPABILITY,
  PROJECT_GROUP_FOLDER_ARCHIVE_RUNTIME_CAPABILITY
} from '../../shared/remote-runtime/protocol/worktree-runtime-capabilities'
import { worktreeRemovalReplyTimeoutMs } from '../../shared/worktree/removal/archive-hook-removal-gate'
import {
  folderIdOfSelector,
  folderWorkspaceKey
} from '../../shared/workspace/identity/workspace-scope'
import { formatWorktreeShow } from './workspace-format'
import { requireArchiveHookPin } from './worktree-removal-request'
import { parseExecutionHostId } from '../../shared/execution-host/execution-host'
import { printResult } from '../output/command-result-output'
import { getOptionalStringFlag, getOptionalStringFlagAllowingEmpty } from '../arguments/flags'
import { RuntimeClientError } from '../runtime/connection/types'
import type { RuntimeClient } from '../runtime/client'
import type { RuntimeRpcSuccess } from '../../shared/remote-runtime/rpc/runtime-rpc-envelope'
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
async function assertUniqueIdMutationSupported(client: RuntimeClient): Promise<RuntimeStatus> {
  const status = await client.call<RuntimeStatus>('status.get')
  if (
    !status.result.capabilities?.includes(FOLDER_WORKSPACE_UNIQUE_ID_MUTATION_RUNTIME_CAPABILITY)
  ) {
    throw new RuntimeClientError(
      'incompatible_runtime',
      'This Orca cannot change folder workspaces from the CLI safely. Update Orca on the computer that owns the folder workspace. Nothing was changed.'
    )
  }
  return status.result
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
  const result = await removeFolderWorkspace(client, flags, selector, folderId)
  printRemovalHookWarnings(result.result, result.result.archiveHook, json)
  printResult(result, json, (value) =>
    [
      'removed: true\nOrca no longer lists this folder workspace; the folder stays on disk.',
      formatArchiveHookLine(value.archiveHook)
    ].join('\n')
  )
  return true
}

async function removeFolderWorkspace(
  client: RuntimeClient,
  flags: Flags,
  selector: string,
  folderId: string
): Promise<RuntimeRpcSuccess<RuntimeWorktreeRemoveResult & { archiveHook: ArchiveHookReport }>> {
  refuseFolderFlags(flags, [['delete-branch', 'does not apply: a folder workspace has no branch.']])
  const archiveChoice = getArchiveHookChoice(flags)
  const allowFailedArchiveHook = flags.get('allow-failed-archive-hook') === true
  const status = await assertUniqueIdMutationSupported(client)
  const supported = status.capabilities?.includes(PROJECT_GROUP_FOLDER_ARCHIVE_RUNTIME_CAPABILITY)
  if (archiveChoice === 'run' && !supported) {
    throw new RuntimeClientError(
      'incompatible_runtime',
      'Update Orca on the computer that owns this folder workspace to run its Archive script. Nothing was changed.'
    )
  }
  // A host without folder Archive support never runs it, as the app's Delete doesn't there.
  const archive =
    archiveChoice === 'inherit' && !supported
      ? { runHooks: false, report: { decision: 'skip' as const, reason: 'older-host' as const } }
      : await folderArchiveHookRequest(client, archiveChoice, selector, folderId)
  const params = {
    folderWorkspaceId: folderId,
    requireUniqueId: true,
    ...(archive.runHooks
      ? {
          runHooks: true,
          allowFailedArchiveHook,
          ...(archive.approvedArchiveHash
            ? { approvedArchiveHash: archive.approvedArchiveHash }
            : {})
        }
      : {})
  }
  const removal = await client.call<
    { deleted: boolean } & Pick<
      RuntimeWorktreeRemoveResult,
      'archiveHookOverride' | 'archiveHookRan'
    >
  >('folderWorkspace.delete', params, {
    timeoutMs: worktreeRemovalReplyTimeoutMs(archive.runHooks),
    ...(archive.approvedArchiveHash ? { requestSelection: requireArchiveHookPin(params) } : {})
  })
  if (!removal.result.deleted) {
    throw folderGone(folderId)
  }
  return {
    ...removal,
    result: {
      removed: true,
      ...(removal.result.archiveHookOverride
        ? { archiveHookOverride: removal.result.archiveHookOverride }
        : {}),
      archiveHook: archiveHookReport(archive, removal.result)
    }
  }
}

async function folderArchiveHookRequest(
  client: RuntimeClient,
  archiveChoice: ArchiveHookChoice,
  selector: string,
  folderId: string
): Promise<ArchiveHookRequest> {
  const target = async (): Promise<ArchiveHookApprovalRequest> => ({
    folderWorkspaceId: folderId,
    hostId: (await folderWorkspaceHostId(client, selector)) ?? 'local'
  })
  if (archiveChoice !== 'inherit') {
    return resolveArchiveHookRequest(client, archiveChoice, target)
  }
  const request = await target()
  // The app runs no scripts for a folder on an SSH host, so its Delete has nothing to run.
  if (parseExecutionHostId(request.hostId)?.kind === 'ssh') {
    return { runHooks: false, report: { decision: 'run', reason: 'approved' } }
  }
  return resolveArchiveHookRequest(client, archiveChoice, async () => request)
}

async function folderWorkspaceHostId(
  client: RuntimeClient,
  selector: string
): Promise<string | undefined> {
  const shown = await client.call<{ worktree: RuntimeWorktreeRecord }>('worktree.show', {
    worktree: selector
  })
  return shown.result.worktree.hostId ?? undefined
}

export function refuseFolderWorkspaceActivation(folderId: string): never {
  throw new RuntimeClientError(
    'invalid_argument',
    `Activating a folder workspace from the CLI is not supported yet. Open it from the Orca sidebar, or inspect it with orca worktree show --worktree ${folderWorkspaceKey(folderId)} --json.`
  )
}
