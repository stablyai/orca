import type { RpcSendParams } from '../transport/rpc-params-contract'
import {
  hostReplyErrorTextOrFallback,
  refusedRpcMessageOrFallback
} from '../transport/rpc-refusal-message'
import type { RpcResponse } from '../transport/types'
import { gitBulkStageRun, gitCommitRun, gitPushRun } from './mobile-git-mutation-operations'
import { gitStatusProjectionRead } from './mobile-git-read-operations'
import type { MobileGitStatusResult } from './mobile-git-status'
import type { MobileSourceControlRpcSender } from './mobile-source-control-rpc-sender'

export type MobileHostedReviewStatusReadResult =
  | { ok: true; status: MobileGitStatusResult | null }
  | { ok: false; error: string }

export type MobileHostedReviewMutationResult = { ok: true } | { ok: false; error: string }

export async function readMobileHostedReviewGitStatus(
  client: MobileSourceControlRpcSender,
  worktreeId: string
): Promise<MobileHostedReviewStatusReadResult> {
  const reply = await gitStatusProjectionRead.request(client, { worktree: `id:${worktreeId}` })
  try {
    return { ok: true, status: gitStatusProjectionRead.interpret(reply) }
  } catch (error) {
    return {
      ok: false,
      error: refusedRpcMessageOrFallback(error, 'Unable to refresh source control')
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

/**
 * One settle shape for the preparation mutations. Two catches because main had two paths: a
 * refusal with no message falls back to the step's copy, while a transport drop surfaces its own
 * message verbatim and keeps its delivery-unknown mark on the way out.
 */
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
  client: MobileSourceControlRpcSender,
  params: RpcSendParams<'git.push'>,
  fallback: string
): Promise<MobileHostedReviewMutationResult> {
  return settleMobileHostedReviewMutation(
    () => gitPushRun.request(client, params),
    (reply) => gitPushRun.interpret(reply),
    fallback
  )
}

export function stageMobileHostedReviewPaths(
  client: MobileSourceControlRpcSender,
  worktreeId: string,
  filePaths: string[]
): Promise<MobileHostedReviewMutationResult> {
  return settleMobileHostedReviewMutation(
    () => gitBulkStageRun.request(client, { worktree: `id:${worktreeId}`, filePaths }),
    (reply) => gitBulkStageRun.interpret(reply),
    'Failed to stage changes'
  )
}

export async function commitMobileHostedReviewStagedChanges(
  client: MobileSourceControlRpcSender,
  worktreeId: string,
  message: string
): Promise<MobileHostedReviewMutationResult> {
  let reply: RpcResponse
  try {
    reply = await gitCommitRun.request(client, { worktree: `id:${worktreeId}`, message })
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Commit failed' }
  }
  let outcome: ReturnType<typeof gitCommitRun.interpret>
  try {
    outcome = gitCommitRun.interpret(reply)
  } catch (error) {
    return { ok: false, error: refusedRpcMessageOrFallback(error, 'Commit failed') }
  }
  // An accepted reply still reports in-band, so `success: false` is a failed commit.
  return outcome.success === true
    ? { ok: true }
    : { ok: false, error: hostReplyErrorTextOrFallback(outcome.error, 'Commit failed') }
}
