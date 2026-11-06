import { z } from 'zod'
import { WORKTREE_REMOVE_BRANCH_POLICY_RUNTIME_CAPABILITY } from '../../shared/worktree-runtime-capabilities'
import type { RuntimeWorktreeRemoveResult } from '../../shared/runtime-types'
import { worktreeRemovalReplyTimeoutMs } from '../../shared/worktree/archive-hook-removal-gate'
import { RuntimeClientError, type RuntimeClient, type RuntimeRpcSuccess } from '../runtime-client'

export type WorktreeRemovalRequest = {
  worktree: string
  hostId: string
  force: boolean
  deleteBranch?: boolean
  runHooks: boolean
  allowFailedArchiveHook: boolean
}

/** Callers act on the exit status, so ask the host for Git's outcome rather than acceptance. */
export async function requestWorktreeRemoval(
  client: RuntimeClient,
  request: WorktreeRemovalRequest
): Promise<RuntimeRpcSuccess<RuntimeWorktreeRemoveResult>> {
  let dispatched = false
  const { deleteBranch, ...legacyRequest } = request
  const legacy = {
    ...legacyRequest,
    // --force also waives PTY-stop proof.
    allowUnverifiedPtyStop: request.force,
    waitForBackgroundRemoval: true
  }
  try {
    return await client.call<RuntimeWorktreeRemoveResult>('worktree.rm', legacy, {
      timeoutMs: worktreeRemovalReplyTimeoutMs(request.runHooks),
      requestSelection: {
        paramsForStatus: (raw) => {
          const parsed = BranchPolicyStatus.safeParse(raw)
          if (!parsed.success) {
            throw new RuntimeClientError(
              'invalid_runtime_response',
              'The Orca host returned an invalid status response.'
            )
          }
          if (
            parsed.data.capabilities?.includes(WORKTREE_REMOVE_BRANCH_POLICY_RUNTIME_CAPABILITY)
          ) {
            return deleteBranch === undefined ? legacy : { ...legacy, deleteBranch }
          }
          console.error(
            'warning: This Orca host is older and uses its existing branch policy. Keep-by-default and --delete-branch do not apply.'
          )
          return legacy
        },
        onDispatch: () => {
          dispatched = true
        }
      }
    })
  } catch (error) {
    // The host keeps deleting after this client stops waiting.
    if (dispatched && error instanceof RuntimeClientError && error.code === 'runtime_timeout') {
      throw new RuntimeClientError(
        'worktree_removal_in_progress',
        `Stopped waiting, but Orca may still be deleting the checkout. Check \`orca worktree show --worktree ${request.worktree}\` before retrying.`
      )
    }
    throw error
  }
}

const BranchPolicyStatus = z.object({ capabilities: z.array(z.string()).optional() })
