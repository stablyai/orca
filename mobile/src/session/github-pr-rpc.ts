import type { RpcClient } from '../transport/rpc-client'
import { withGitHubTargetOperation } from '../tasks/github-work-item-operation'
import { requireGitHubWorkItemTargetDetails } from '../../../src/shared/github/work-item-target'
import type { PRCheckDetail, PRCheckRunDetails } from '../../../src/shared/github/check-types'
import type {
  GitHubAssignableUser,
  GitHubOwnerRepo,
  PRInfo
} from '../../../src/shared/github/pull-request-types'
import type { GitHubWorkItemDetails } from '../../../src/shared/github/work-item-types'
import type { HostedReviewInfo } from '../../../src/shared/hosted-review'
import { refusedRpcMessageOrFallback } from '../transport/rpc-refusal-message'
import type { RpcResponse } from '../transport/types'
import { mobileRepoSelectorFromWorktreeId } from '../source-control/mobile-pr-create'
import type { GitHubPrForBranchOutcome } from './github-pr-read-reply-schema'
import {
  githubPrAssignableUsersRead,
  githubPrCheckDetailsRead,
  githubPrChecksRead,
  githubPrForBranchRead,
  githubPrRepoSlugRead,
  githubPrWorkItemDetailsRead,
  hostedReviewBranchLookupRead
} from './github-pr-read-operations'
import type { GitHubPrSettleableOperation } from './github-pr-mutation-outcome'
import { githubPrRequestParams, type GitHubPrRepoSlug } from './github-pr-repo-slug'
import type { RpcOperationSender } from '../transport/rpc-operation-sender'
import { translate } from '../i18n/mobile-i18n'

export {
  buildGithubPrParams,
  githubPrRepoSlugParam,
  type GitHubPrRepoSlug
} from './github-pr-repo-slug'

export type GitHubPrReadOutcome<T> = { ok: true; result: T } | { ok: false; error: string }

// Refusals without text use method fallback; decode/in-band upstream errors preserve their own text.
function githubPrFailureText(reply: RpcResponse, error: unknown, fallback: string): string {
  if (!reply.ok) {
    return refusedRpcMessageOrFallback(error, fallback)
  }
  return error instanceof Error ? error.message : fallback
}

async function settleGithubPrRead<Value>(
  read: GitHubPrSettleableOperation<Value>,
  send: () => Promise<RpcResponse>
): Promise<GitHubPrReadOutcome<Value>> {
  const fallback = translate('session.githubPrRpc.requestFailed', 'Request failed: {{method}}', {
    method: read.operation.method
  })
  let reply: RpcResponse
  try {
    reply = await send()
  } catch (error) {
    // A transport drop surfaces its own message verbatim, empty included.
    return { ok: false, error: error instanceof Error ? error.message : fallback }
  }
  try {
    return { ok: true, result: read.interpret(reply) }
  } catch (error) {
    return { ok: false, error: githubPrFailureText(reply, error, fallback) }
  }
}

// Gate the PR icon on a GitHub remote independently of whether this branch has an open PR.
export function fetchGithubRepoSlug(
  client: RpcOperationSender,
  worktreeId: string
): Promise<GitHubPrReadOutcome<GitHubPrRepoSlug | null>> {
  return settleGithubPrRead(githubPrRepoSlugRead, () =>
    githubPrRepoSlugRead.request(
      client,
      githubPrRequestParams(githubPrRepoSlugRead.operation.method, worktreeId, {})
    )
  )
}

export function fetchHostedReviewForBranch(
  client: RpcOperationSender,
  worktreeId: string,
  args: { branch: string; linkedGitHubPR?: number | null }
): Promise<GitHubPrReadOutcome<HostedReviewInfo | null>> {
  return settleGithubPrRead(hostedReviewBranchLookupRead, () =>
    hostedReviewBranchLookupRead.request(client, {
      repo: mobileRepoSelectorFromWorktreeId(worktreeId),
      branch: args.branch,
      linkedGitHubPR: args.linkedGitHubPR ?? null,
      // Why: the mobile PR sidebar is only ever open on the selected worktree,
      // so it belongs in the host's fast re-check tier (#11532).
      active: true
    })
  )
}

// Raise decoded upstream-error here so the sidebar retains host text; it is not a protocol decode failure.
export function fetchPRForBranch(
  client: RpcOperationSender,
  worktreeId: string,
  args: {
    branch: string
    linkedPRNumber?: number | null
    fallbackPRNumber?: number | null
    currentHeadOid?: string | null
  }
): Promise<GitHubPrReadOutcome<PRInfo | null>> {
  return settleGithubPrRead(
    {
      operation: githubPrForBranchRead.operation,
      interpret: (reply) => resolveGithubPrForBranchOutcome(githubPrForBranchRead.interpret(reply))
    },
    () =>
      githubPrForBranchRead.request(
        client,
        githubPrRequestParams(githubPrForBranchRead.operation.method, worktreeId, {
          branch: args.branch,
          linkedPRNumber: args.linkedPRNumber ?? null,
          fallbackPRNumber: args.fallbackPRNumber ?? null,
          currentHeadOid: args.currentHeadOid ?? null
        })
      )
  )
}

function resolveGithubPrForBranchOutcome(outcome: GitHubPrForBranchOutcome | null): PRInfo | null {
  if (outcome === null) {
    return null
  }
  if (outcome.kind === 'upstream-error') {
    throw new Error(outcome.message)
  }
  return outcome.kind === 'found' ? outcome.pr : null
}

export async function fetchWorkItemDetails(
  client: RpcClient,
  worktreeId: string,
  args: { prNumber: number; prRepo?: GitHubPrRepoSlug | null }
): Promise<GitHubPrReadOutcome<GitHubWorkItemDetails | null>> {
  const params = githubPrRequestParams(githubPrWorkItemDetailsRead.operation.method, worktreeId, {
    number: args.prNumber,
    type: 'pr'
  })
  const outcome = await settleGithubPrRead(githubPrWorkItemDetailsRead, () =>
    args.prRepo
      ? withGitHubTargetOperation({
          client,
          params: { repo: mobileRepoSelectorFromWorktreeId(worktreeId) },
          ownerRepo: args.prRepo,
          read: true,
          send: (selected, exact, options) =>
            githubPrWorkItemDetailsRead.request(selected, { ...params, ...exact }, options)
        })
      : githubPrWorkItemDetailsRead.request(client, params)
  )
  if (outcome.ok && args.prRepo) {
    try {
      return {
        ok: true,
        result: requireGitHubWorkItemTargetDetails(outcome.result, {
          repository: args.prRepo,
          type: 'pr',
          number: args.prNumber
        })
      }
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'Unable to load pull request details.'
      }
    }
  }
  return outcome
}

export function fetchPRChecks(
  client: RpcOperationSender,
  worktreeId: string,
  args: { prNumber: number; headSha?: string | null; prRepo?: GitHubPrRepoSlug | null }
): Promise<GitHubPrReadOutcome<PRCheckDetail[]>> {
  return settleGithubPrRead(githubPrChecksRead, () =>
    githubPrChecksRead.request(
      client,
      githubPrRequestParams(
        githubPrChecksRead.operation.method,
        worktreeId,
        { prNumber: args.prNumber },
        { prRepo: args.prRepo, headSha: args.headSha }
      )
    )
  )
}

export function fetchPRCheckDetails(
  client: RpcOperationSender,
  worktreeId: string,
  args: {
    checkRunId?: number
    workflowRunId?: number
    checkName?: string
    url?: string | null
    prRepo?: GitHubPrRepoSlug | null
  }
): Promise<GitHubPrReadOutcome<PRCheckRunDetails | null>> {
  const params: Record<string, unknown> = {}
  if (args.checkRunId !== undefined) {
    params.checkRunId = args.checkRunId
  }
  if (args.workflowRunId !== undefined) {
    params.workflowRunId = args.workflowRunId
  }
  if (args.checkName !== undefined) {
    params.checkName = args.checkName
  }
  if (args.url !== undefined) {
    params.url = args.url
  }
  return settleGithubPrRead(githubPrCheckDetailsRead, () =>
    githubPrCheckDetailsRead.request(
      client,
      githubPrRequestParams(githubPrCheckDetailsRead.operation.method, worktreeId, params, {
        prRepo: args.prRepo
      })
    )
  )
}

export function fetchAssignableUsers(
  client: RpcClient,
  worktreeId: string,
  prRepo: GitHubOwnerRepo | null
): Promise<GitHubPrReadOutcome<GitHubAssignableUser[]>> {
  return settleGithubPrRead(githubPrAssignableUsersRead, () => {
    if (!prRepo) {
      throw new Error('Unable to identify this pull request. Open it again.')
    }
    const params = githubPrRequestParams(
      githubPrAssignableUsersRead.operation.method,
      worktreeId,
      {}
    )
    return withGitHubTargetOperation({
      client,
      params,
      ownerRepo: prRepo,
      send: (selected, exact, options) =>
        githubPrAssignableUsersRead.request(selected, { ...params, ...exact }, options)
    })
  })
}
