import type { RpcClient } from '../transport/rpc-client'
import type { MobileGitStatusResult } from './mobile-git-status'
import {
  createMobilePr,
  getMobilePrCreateBlockMessage,
  getMobilePrCreateSuccessWarning,
  shouldPushBeforeMobilePrCreate,
  type MobilePrPrefill
} from './mobile-pr-create'
import {
  prepareMobileHostedReviewCreateIntent,
  type MobileHostedReviewCreateIntentProgress
} from './mobile-hosted-review-create-intent'

type RunInput = {
  branch: string
  title: string
  status: MobileGitStatusResult | null
  commitMessage?: string
  onProgress?: (progress: MobileHostedReviewCreateIntentProgress) => void
}

export type MobileHostedReviewCreateIntentRunOutcome =
  | {
      ok: true
      url: string
      warning?: string
      prefill: MobilePrPrefill
      status: MobileGitStatusResult | null
      committed: boolean
    }
  | {
      ok: false
      error: string
      committed?: boolean
      status?: MobileGitStatusResult | null
      commitMessage?: string
    }

export function isMobileHostedReviewCommitFailure(
  outcome: MobileHostedReviewCreateIntentRunOutcome,
  progress: MobileHostedReviewCreateIntentProgress | null
): outcome is Extract<MobileHostedReviewCreateIntentRunOutcome, { ok: false }> & {
  committed: false
} {
  return !outcome.ok && progress === 'committing' && outcome.committed === false
}

export async function runMobileHostedReviewCreateIntent(
  client: Pick<RpcClient, 'sendRequest'>,
  worktreeId: string,
  input: RunInput
): Promise<MobileHostedReviewCreateIntentRunOutcome> {
  const prepared = await prepareMobileHostedReviewCreateIntent(client, worktreeId, input)
  if (!prepared.ok) {
    return prepared
  }

  const blockedMessage = getMobilePrCreateBlockMessage(prepared.prefill)
  if (blockedMessage) {
    return {
      ok: false,
      error: blockedMessage,
      committed: prepared.committed,
      status: prepared.status
    }
  }

  input.onProgress?.('creating_review')
  const created = await createMobilePr(client, worktreeId, {
    provider: prepared.prefill.provider,
    base: prepared.prefill.base,
    head: input.branch,
    title: prepared.prefill.title,
    body: prepared.prefill.body,
    draft: false,
    pushBeforeCreate: shouldPushBeforeMobilePrCreate(prepared.prefill)
  })
  if (!created.ok) {
    return {
      ok: false,
      error: created.error,
      committed: prepared.committed,
      status: prepared.status
    }
  }

  return {
    ok: true,
    url: created.url,
    warning: getMobilePrCreateSuccessWarning(created, prepared.prefill.provider),
    prefill: prepared.prefill,
    status: prepared.status,
    committed: prepared.committed
  }
}
