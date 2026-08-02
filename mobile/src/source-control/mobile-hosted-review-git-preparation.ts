import type { RpcClient } from '../transport/rpc-client'
import type { RpcSuccess } from '../transport/types'
import { readMobileGitStatusResult } from '../session/mobile-diff-review-rpc'
import type { MobileGitStatusResult } from './mobile-git-status'

export type MobileHostedReviewStatusReadResult =
  | { ok: true; status: MobileGitStatusResult | null }
  | { ok: false; error: string }

export async function readMobileHostedReviewGitStatus(
  client: Pick<RpcClient, 'sendRequest'>,
  worktreeId: string
): Promise<MobileHostedReviewStatusReadResult> {
  const response = await client.sendRequest('git.status', { worktree: `id:${worktreeId}` })
  if (!response.ok) {
    return { ok: false, error: response.error?.message || 'Unable to refresh source control' }
  }
  return { ok: true, status: readMobileGitStatusResult((response as RpcSuccess).result) }
}

export function mobileHostedReviewBranchStillMatches(
  inputBranch: string,
  status: MobileGitStatusResult | null
): boolean {
  const branch = status?.branch
  return Boolean(branch && (branch === inputBranch || branch === `refs/heads/${inputBranch}`))
}

export async function sendMobileHostedReviewGitMutation(
  client: Pick<RpcClient, 'sendRequest'>,
  method: string,
  params: Record<string, unknown>,
  fallback: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const response = await client.sendRequest(method, params)
    if (!response.ok) {
      return { ok: false, error: response.error?.message || fallback }
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : fallback }
  }
}

export async function commitMobileHostedReviewStagedChanges(
  client: Pick<RpcClient, 'sendRequest'>,
  worktreeId: string,
  message: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const response = await client.sendRequest('git.commit', {
      worktree: `id:${worktreeId}`,
      message
    })
    if (!response.ok) {
      return { ok: false, error: response.error?.message || 'Commit failed' }
    }
    const result = (response as RpcSuccess).result as { success?: boolean; error?: string }
    if (result?.success !== true) {
      return { ok: false, error: result?.error || 'Commit failed' }
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Commit failed' }
  }
}
