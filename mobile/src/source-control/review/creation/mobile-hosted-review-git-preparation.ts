import { translate } from '../../../i18n/mobile-i18n'
import type { RpcSendParams } from '../../../../../src/shared/rpc-contract/rpc-send-params'
import {
  hostReplyErrorTextOrFallback,
  refusedRpcMessageOrFallback
} from '../../../transport/rpc/rpc-refusal-message'
import type { RpcResponse } from '../../../transport/rpc/rpc-wire-types'
import {
  gitBulkStageRun,
  gitCommitRun,
  gitFastForwardRun,
  gitPushRun
} from '../../git/mobile-git-mutation-operations'
import { gitStatusProjectionRead } from '../../git/mobile-git-read-operations'
import type { MobileGitStatusHostPayload as MobileGitStatusResult } from '../../git/git-status-reply-schema'
import type { UnvalidatedRpcRequestPort } from '../../../transport/rpc/unvalidated-rpc-request-port'

export type MobileHostedReviewStatusReadResult =
  | { ok: true; status: MobileGitStatusResult | null }
  | { ok: false; error: string }

export type MobileHostedReviewMutationResult = { ok: true } | { ok: false; error: string }

export async function readMobileHostedReviewGitStatus(
  client: UnvalidatedRpcRequestPort,
  worktreeId: string
): Promise<MobileHostedReviewStatusReadResult> {
  const reply = await gitStatusProjectionRead.request(client, { worktree: `id:${worktreeId}` })
  try {
    return { ok: true, status: gitStatusProjectionRead.interpret(reply) }
  } catch (error) {
    return {
      ok: false,
      error: refusedRpcMessageOrFallback(
        error,
        translate(
          'sourceControl.hostedReviewGitPreparation.refreshFailed',
          'Unable to refresh source control'
        )
      )
    }
  }
}

export function mobileHostedReviewBranchStillMatches(
  inputBranch: string,
  status: MobileGitStatusResult | null
): boolean {
  const branch = status?.branch
  return Boolean(branch && (branch === inputBranch || branch === `refs/heads/${inputBranch}`))
}

// Refusal without a message uses step copy; transport errors retain their own message and delivery-unknown mark.
async function settleMobileHostedReviewMutation(
  send: () => Promise<RpcResponse>,
  interpret: (reply: RpcResponse) => unknown,
  fallback: string
): Promise<MobileHostedReviewMutationResult> {
  let reply: RpcResponse
  try {
    reply = await send()
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : fallback }
  }
  try {
    interpret(reply)
  } catch (error) {
    return { ok: false, error: refusedRpcMessageOrFallback(error, fallback) }
  }
  return { ok: true }
}

export function pushMobileHostedReviewBranch(
  client: UnvalidatedRpcRequestPort,
  params: RpcSendParams<'git.push'>,
  fallback: string
): Promise<MobileHostedReviewMutationResult> {
  return settleMobileHostedReviewMutation(
    () => gitPushRun.request(client, params),
    (reply) => gitPushRun.interpret(reply),
    fallback
  )
}

export function fastForwardMobileHostedReviewBranch(
  client: UnvalidatedRpcRequestPort,
  worktreeId: string
): Promise<MobileHostedReviewMutationResult> {
  return settleMobileHostedReviewMutation(
    () => gitFastForwardRun.request(client, { worktree: `id:${worktreeId}` }),
    (reply) => gitFastForwardRun.interpret(reply),
    translate(
      'sourceControl.hostedReviewGitPreparation.updateBranchFailed',
      'Could not update the remote branch. Retry Create PR.'
    )
  )
}

export function stageMobileHostedReviewPaths(
  client: UnvalidatedRpcRequestPort,
  worktreeId: string,
  filePaths: string[]
): Promise<MobileHostedReviewMutationResult> {
  return settleMobileHostedReviewMutation(
    () => gitBulkStageRun.request(client, { worktree: `id:${worktreeId}`, filePaths }),
    (reply) => gitBulkStageRun.interpret(reply),
    translate('sourceControl.hostedReviewGitPreparation.stageFailed', 'Failed to stage changes')
  )
}

export async function commitMobileHostedReviewStagedChanges(
  client: UnvalidatedRpcRequestPort,
  worktreeId: string,
  message: string
): Promise<MobileHostedReviewMutationResult> {
  let reply: RpcResponse
  try {
    reply = await gitCommitRun.request(client, { worktree: `id:${worktreeId}`, message })
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : translate('sourceControl.hostedReviewGitPreparation.commitFailed', 'Commit failed')
    }
  }
  let outcome: ReturnType<typeof gitCommitRun.interpret>
  try {
    outcome = gitCommitRun.interpret(reply)
  } catch (error) {
    return {
      ok: false,
      error: refusedRpcMessageOrFallback(
        error,
        translate('sourceControl.hostedReviewGitPreparation.commitFailed', 'Commit failed')
      )
    }
  }
  // Acceptance can still carry an in-band commit failure.
  return outcome.success === true
    ? { ok: true }
    : {
        ok: false,
        error: hostReplyErrorTextOrFallback(
          outcome.error,
          translate('sourceControl.hostedReviewGitPreparation.commitFailed', 'Commit failed')
        )
      }
}
