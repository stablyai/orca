import { translate } from '../i18n/mobile-i18n'
import { refusedRpcMessageOrFallback } from '../transport/rpc-refusal-message'
import type { RpcOperationSender } from '../transport/rpc-operation-sender'
import { resolveCreateReviewSeedFromCommits } from '../../../src/shared/hosted-review-create-seed'
import {
  normalizeCreateReviewBaseSearchResults,
  normalizeHostedReviewBaseRef
} from '../../../src/shared/hosted-review-refs'
import { TEXT_GENERATION_CLIENT_TIMEOUT_MS } from '../../../src/shared/text-generation-client-timeout'
import type { HostedReviewProvider } from '../../../src/shared/hosted-review'
import type { MobileGitStatusResult } from './mobile-git-status'
import { fetchMobileGitHistory } from './mobile-git-history'
import type { MobileGitHistoryItem, MobileGitHistoryResult } from './git-history-reply-schema'
import { getMobilePrEligibilityReadiness } from './mobile-open-pr-prefill'
import {
  mobileRepoSelectorFromWorktreeId,
  resolveMobilePrPrefill,
  type MobilePrPrefill
} from './mobile-pr-create'
import {
  gitCancelGeneratePullRequestFieldsRun,
  gitGeneratePullRequestFieldsRun,
  type MobileGeneratePullRequestFieldsResult
} from './mobile-git-mutation-operations'
import { repoBaseRefSearchRead } from './mobile-repo-base-ref-operations'

export type MobilePrCreateDraft = {
  prefill: MobilePrPrefill
  title: string
  body: string
  base: string
}

const HOSTED_PROVIDERS: readonly HostedReviewProvider[] = [
  'github',
  'gitlab',
  'bitbucket',
  'azure-devops',
  'gitea'
]

// The host's prefill decides provider, base and blockers; the branch's commits seed the text.
export async function loadMobilePrCreateDraft(
  client: RpcOperationSender,
  worktreeId: string,
  input: { branch: string; status: MobileGitStatusResult | null; commitsAhead?: number | null }
): Promise<MobilePrCreateDraft> {
  const prefill = await resolveMobilePrPrefill(client, worktreeId, {
    branch: input.branch,
    title: '',
    ...getMobilePrEligibilityReadiness(input.status)
  })
  // A failed history read still leaves the branch-name seed.
  const history = await fetchMobileGitHistory(client, worktreeId).catch(() => null)
  const commits = history
    ? branchCommitsSinceBase(history, input.commitsAhead)
        .toReversed()
        .map((item) => ({ subject: item.subject ?? '', body: commitBody(item.message) }))
    : []
  const seed = resolveCreateReviewSeedFromCommits({
    branch: input.branch,
    eligibility: {
      provider: HOSTED_PROVIDERS.find((value) => value === prefill.provider),
      title: prefill.title,
      body: prefill.body
    },
    commits
  })
  // The host's default can be remote-qualified (origin/main); the API and the picker use branch names.
  return {
    prefill,
    title: seed.title,
    body: seed.body,
    base: normalizeHostedReviewBaseRef(prefill.base)
  }
}

function commitBody(message: string | undefined): string {
  if (!message) {
    return ''
  }
  const newline = message.indexOf('\n')
  return newline === -1 ? '' : message.slice(newline + 1).trim()
}

export async function generateMobilePrFields(
  client: RpcOperationSender,
  worktreeId: string,
  input: { base: string; title: string; body: string; draft: boolean; provider: string }
): Promise<MobileGeneratePullRequestFieldsResult> {
  const provider = HOSTED_PROVIDERS.find((value) => value === input.provider)
  const reply = await gitGeneratePullRequestFieldsRun.request(
    client,
    {
      worktree: `id:${worktreeId}`,
      base: input.base,
      title: input.title,
      body: input.body,
      draft: input.draft,
      ...(provider ? { provider } : {})
    },
    { timeoutMs: TEXT_GENERATION_CLIENT_TIMEOUT_MS }
  )
  try {
    return gitGeneratePullRequestFieldsRun.interpret(reply)
  } catch (error) {
    return {
      success: false,
      error: refusedRpcMessageOrFallback(
        error,
        translate('sourceControl.prCreateDraft.generateFailed', 'Failed to write a description')
      )
    }
  }
}

// The host runs one generation per lane, so an abandoned one would delay the next.
export async function cancelMobilePrFields(
  client: RpcOperationSender,
  worktreeId: string
): Promise<void> {
  const reply = await gitCancelGeneratePullRequestFieldsRun.request(client, {
    worktree: `id:${worktreeId}`
  })
  gitCancelGeneratePullRequestFieldsRun.interpret(reply)
}

export async function searchMobilePrBaseRefs(
  client: RpcOperationSender,
  worktreeId: string,
  query: string
): Promise<string[]> {
  const reply = await repoBaseRefSearchRead.request(
    client,
    { repo: mobileRepoSelectorFromWorktreeId(worktreeId), query, limit: 20 },
    { timeoutMs: 30_000 }
  )
  const result = repoBaseRefSearchRead.interpret(reply)
  return normalizeCreateReviewBaseSearchResults(
    result.refDetails ?? (result.refs ?? []).map((refName) => ({ refName, localBranchName: '' }))
  )
}

// The ahead count names the branch's own commits only in linear history; a merge in range means unknown.
export function branchCommitsSinceBase(
  result: MobileGitHistoryResult,
  commitsAhead: number | null | undefined
): MobileGitHistoryItem[] {
  if (commitsAhead == null || result.items.length < commitsAhead) {
    return []
  }
  const commits = result.items.slice(0, commitsAhead)
  return commits.some((item) => item.parentIds.length > 1) ? [] : commits
}
