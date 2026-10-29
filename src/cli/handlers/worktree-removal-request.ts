import type { RuntimeWorktreeRemoveResult } from '../../shared/runtime-types'
import { worktreeRemovalReplyTimeoutMs } from '../../shared/worktree/archive-hook-removal-gate'
import { RuntimeClientError, type RuntimeClient, type RuntimeRpcSuccess } from '../runtime-client'

export type WorktreeRemovalRequest = {
  worktree: string
  hostId: string
  force: boolean
  runHooks: boolean
  allowFailedArchiveHook: boolean
}

/** Callers act on the exit status, so ask the host for Git's outcome rather than acceptance. */
export async function requestWorktreeRemoval(
  client: RuntimeClient,
  request: WorktreeRemovalRequest
): Promise<RuntimeRpcSuccess<RuntimeWorktreeRemoveResult>> {
  try {
    return await client.call<RuntimeWorktreeRemoveResult>(
      'worktree.rm',
      {
        ...request,
        // --force also waives PTY-stop proof.
        allowUnverifiedPtyStop: request.force,
        waitForBackgroundRemoval: true
      },
      { timeoutMs: worktreeRemovalReplyTimeoutMs(request.runHooks) }
    )
  } catch (error) {
    // The host keeps deleting after this client stops waiting.
    if (error instanceof RuntimeClientError && error.code === 'runtime_timeout') {
      throw new RuntimeClientError(
        'worktree_removal_in_progress',
        `Stopped waiting, but Orca may still be deleting the checkout. Check \`orca worktree show --worktree ${request.worktree}\` before retrying.`
      )
    }
    throw error
  }
}
