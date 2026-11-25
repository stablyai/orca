import { worktreeRemovalReplyTimeoutMs } from '../../../../src/shared/worktree/removal/archive-hook-removal-gate'
import { RECIPE_REMOVAL_REPLY_TIMEOUT_MS } from '../../../../src/shared/remote-runtime/ephemeral-vm-recipes/recipe-host-removal'
import { parseWorkspaceKey } from '../../../../src/shared/workspace/identity/workspace-scope'
import type { ExecutionHostId } from '../../../../src/shared/execution-host/execution-host'
import type { Worktree } from '../../worktree/workspace-list/workspace-list-types'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import { folderWorkspaceRemove, worktreeRemove } from '../host-screen-operations'

export type WorktreeRemoveHooks = {
  runHooks: boolean
  allowFailedArchiveHook?: true
}

type WorktreeRemoveRequest =
  | {
      kind: 'folder'
      params: WorktreeRemoveHooks & { folderWorkspaceId: string; requireUniqueId: true }
      timeoutMs: number
    }
  | {
      kind: 'worktree'
      params: WorktreeRemoveHooks & {
        worktree: string
        force: true
        hostId?: ExecutionHostId
        destroyHost?: true
      }
      timeoutMs: number
    }

/** The phone's delete: a folder row leaves Orca as desktop's Remove Workspace does (git cannot select it); a row
 *  the desktop tagged with its recipe environment also asks for that environment's destroy, which the delete sheet named. */
function buildWorktreeRemoveRequest(
  item: Pick<Worktree, 'worktreeId' | 'recipeEnvironment' | 'hostId'>,
  hooks: WorktreeRemoveHooks
): WorktreeRemoveRequest {
  const scope = parseWorkspaceKey(item.worktreeId)
  if (scope?.type === 'folder') {
    return {
      kind: 'folder',
      // Like the CLI: an id two folder workspaces share is refused, never guessed.
      params: { folderWorkspaceId: scope.folderWorkspaceId, requireUniqueId: true, ...hooks },
      timeoutMs: worktreeRemovalReplyTimeoutMs(hooks.runHooks)
    }
  }
  const destroysEnvironment = item.recipeEnvironment !== undefined
  return {
    kind: 'worktree',
    params: {
      worktree: `id:${item.worktreeId}`,
      force: true,
      // Pin the checkout's own host, so a same-id checkout on another host is never resolved instead.
      // A server row's id names the server, not its checkout's host there, so it stays unpinned.
      ...(item.hostId && !item.hostId.startsWith('runtime:') ? { hostId: item.hostId } : {}),
      ...hooks,
      ...(destroysEnvironment ? { destroyHost: true } : {})
    },
    // The host runs the archive hook, and here the recipe's destroy step, before it replies (#19334).
    timeoutMs: destroysEnvironment
      ? RECIPE_REMOVAL_REPLY_TIMEOUT_MS
      : worktreeRemovalReplyTimeoutMs(hooks.runHooks)
  }
}

/** Sends the delete to the row's host; a refusal carries the host's code and message. */
export async function requestWorktreeRemove(
  client: RpcClient,
  item: Pick<Worktree, 'worktreeId' | 'recipeEnvironment' | 'hostId'>,
  hooks: WorktreeRemoveHooks
): Promise<{ accepted: true } | { accepted: false; refusal?: { code: string; message: string } }> {
  const request = buildWorktreeRemoveRequest(item, hooks)
  const options = { timeoutMs: request.timeoutMs }
  const reply =
    request.kind === 'folder'
      ? await folderWorkspaceRemove.request(client, request.params, options)
      : await worktreeRemove.request(client, request.params, options)
  const accepted =
    request.kind === 'folder'
      ? folderWorkspaceRemove.interpret(reply).accepted
      : worktreeRemove.interpret(reply).accepted
  if (accepted) {
    return { accepted: true }
  }
  return reply.ok ? { accepted: false } : { accepted: false, refusal: reply.error }
}
