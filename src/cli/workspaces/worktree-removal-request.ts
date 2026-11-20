import { z } from 'zod'
import {
  WORKTREE_ARCHIVE_HOOK_PIN_RUNTIME_CAPABILITY,
  WORKTREE_REMOVE_BRANCH_POLICY_RUNTIME_CAPABILITY
} from '../../shared/remote-runtime/protocol/worktree-runtime-capabilities'
import { ARCHIVE_HOOK_UNDECIDED_CODE } from '../../shared/worktree/removal/archive-hook-decision'
import type { RuntimeWorktreeRemoveResult } from '../../shared/worktree/catalog/runtime-worktree-contracts'
import { worktreeRemovalReplyTimeoutMs } from '../../shared/worktree/removal/archive-hook-removal-gate'
import { RuntimeClientError } from '../runtime/connection/types'
import type { RuntimeClient } from '../runtime/client'
import type { RuntimeRpcSuccess } from '../../shared/remote-runtime/rpc/runtime-rpc-envelope'

export type WorktreeRemovalRequest = {
  worktree: string
  hostId: string
  force: boolean
  deleteBranch?: boolean
  runHooks: boolean
  /** The desktop-approved archive content; newer hosts refuse when what would run differs. */
  approvedArchiveHash?: string
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
          if (request.approvedArchiveHash !== undefined) {
            assertArchiveHookPinSupported(parsed.data.capabilities)
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

// Checked on the status the call dispatches to: a host restarted into an older build would drop the pin.
function assertArchiveHookPinSupported(capabilities: readonly string[] | undefined): void {
  if (!capabilities?.includes(WORKTREE_ARCHIVE_HOOK_PIN_RUNTIME_CAPABILITY)) {
    throw new RuntimeClientError(
      ARCHIVE_HOOK_UNDECIDED_CODE,
      "This Orca host can't check the approved archive hook. Nothing was deleted. Update Orca there, or pass --archive run or --archive skip."
    )
  }
}

/** Request selection for a mutation carrying approvedArchiveHash. */
export function requireArchiveHookPin<T>(params: T): { paramsForStatus: (raw: unknown) => T } {
  return {
    paramsForStatus: (raw) => {
      assertArchiveHookPinSupported(BranchPolicyStatus.safeParse(raw).data?.capabilities)
      return params
    }
  }
}
