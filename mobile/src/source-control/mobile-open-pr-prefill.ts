import type { RpcClient } from '../transport/rpc-client'
import { readMobileGitStatusResult } from '../session/mobile-diff-review-rpc'
import type { MobileGitStatusResult } from './mobile-git-status'
import { resolveMobilePrPrefill, type MobilePrPrefill } from './mobile-pr-create'

// Resolves the create-PR prefill from a git status snapshot. Split from the
// runners hook to keep that file under the line limit.

// Reads a fresh git.status after a push so the prefill reflects the just-pushed
// branch's upstream/ahead data instead of the pre-push captured status. Best-effort:
// returns the captured status on any read failure.
export async function readFreshGitStatus(
  worktreeId: string,
  fallback: MobileGitStatusResult | null,
  sendGitRequest: <T>(method: string, params?: Record<string, unknown>) => Promise<T>
): Promise<MobileGitStatusResult | null> {
  try {
    const fresh = await sendGitRequest<unknown>('git.status', { worktree: `id:${worktreeId}` })
    return readMobileGitStatusResult(fresh) ?? fallback
  } catch {
    return fallback
  }
}

export async function buildOpenPrPrefill(
  client: Pick<RpcClient, 'sendRequest'> | null,
  worktreeId: string,
  status: MobileGitStatusResult | null,
  branchLabel: string
): Promise<MobilePrPrefill> {
  if (!client) {
    return { provider: 'github', base: 'main', title: branchLabel, body: '' }
  }
  const up = status?.upstreamStatus
  return resolveMobilePrPrefill(client, worktreeId, {
    branch: status?.branch,
    title: branchLabel,
    hasUncommittedChanges: (status?.entries?.length ?? 0) > 0,
    hasUpstream: up?.hasUpstream === true,
    ahead: up?.ahead ?? 0,
    behind: up?.behind ?? 0
  })
}
