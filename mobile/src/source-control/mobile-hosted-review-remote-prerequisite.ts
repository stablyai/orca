import type { RpcClient } from '../transport/rpc-client'
import type { MobileGitStatusResult } from './mobile-git-status'
import type { MobileHostedReviewCreateIntentProgress } from './mobile-hosted-review-create-intent'
import type { MobilePrPrefill } from './mobile-pr-create'
import { sendMobileHostedReviewGitMutation } from './mobile-hosted-review-git-preparation'
import { t } from '@/i18n/mobile-i18n'

type RemotePrerequisiteInput = {
  status: MobileGitStatusResult | null
  onProgress?: (progress: MobileHostedReviewCreateIntentProgress) => void
}

export async function applyMobileHostedReviewRemotePrerequisite(
  client: Pick<RpcClient, 'sendRequest'>,
  worktreeId: string,
  prefill: MobilePrPrefill,
  input: RemotePrerequisiteInput
): Promise<{ ok: true; ran: boolean } | { ok: false; error: string }> {
  switch (prefill.blockedReason) {
    case 'no_upstream': {
      input.onProgress?.('publishing')
      const result = await sendMobileHostedReviewGitMutation(
        client,
        'git.push',
        { worktree: `id:${worktreeId}`, publish: true },
        t('m.HtBxXOI')
      )
      return result.ok ? { ok: true, ran: true } : result
    }
    case 'needs_push': {
      input.onProgress?.('pushing')
      const result = await sendMobileHostedReviewGitMutation(
        client,
        'git.push',
        { worktree: `id:${worktreeId}` },
        t('m.I8tYYd4')
      )
      return result.ok ? { ok: true, ran: true } : result
    }
    case 'needs_sync': {
      if (input.status?.upstreamStatus?.behindCommitsArePatchEquivalent !== true) {
        return { ok: true, ran: false }
      }
      input.onProgress?.('force_pushing')
      const result = await sendMobileHostedReviewGitMutation(
        client,
        'git.push',
        { worktree: `id:${worktreeId}`, forceWithLease: true },
        t('m.2m5o9w0')
      )
      return result.ok ? { ok: true, ran: true } : result
    }
    default:
      return { ok: true, ran: false }
  }
}
