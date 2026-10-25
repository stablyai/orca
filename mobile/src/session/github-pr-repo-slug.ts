import type { RpcMethodName, RpcSendParams } from '../transport/rpc-params-contract'
import { mobileRepoSelectorFromWorktreeId } from '../source-control/mobile-pr-create'

// Preserve fork owner/repo and GHES host across RPC or actions may target a same-named github.com repository.
export type GitHubPrRepoSlug = { owner: string; repo: string; host?: string }

export function githubPrRepoSlugParam(slug: GitHubPrRepoSlug): {
  owner: string
  repo: string
  host?: string
} {
  return { owner: slug.owner, repo: slug.repo, ...(slug.host ? { host: slug.host } : {}) }
}

// Forward prRepo only for methods whose schemas declare it.
const METHODS_ACCEPTING_PR_REPO = new Set<string>([
  'github.prChecks',
  'github.prCheckDetails',
  'github.rerunPRChecks',
  'github.resolveReviewThread',
  'github.setPRFileViewed',
  'github.updatePRState',
  'github.requestPRReviewers',
  'github.removePRReviewers',
  'github.mergePR',
  'github.setPRAutoMerge',
  'github.updatePRTitle',
  'github.prComments',
  'github.prFileContents',
  'github.addPRReviewComment',
  'github.addIssueComment',
  'github.addPRReviewCommentReply'
])

// Only prChecks declares headSha; check runs belong to a commit.
const METHODS_ACCEPTING_HEAD_SHA = new Set<string>(['github.prChecks'])

type GitHubPrParamOptions = {
  prRepo?: GitHubPrRepoSlug | null
  headSha?: string | null
}

export function buildGithubPrParams(
  method: string,
  worktreeId: string,
  params: Record<string, unknown>,
  options?: GitHubPrParamOptions
): Record<string, unknown> {
  const built: Record<string, unknown> = {
    repo: mobileRepoSelectorFromWorktreeId(worktreeId),
    ...params
  }
  if (options?.prRepo && METHODS_ACCEPTING_PR_REPO.has(method) && !('prRepo' in built)) {
    built.prRepo = githubPrRepoSlugParam(options.prRepo)
  }
  if (options?.headSha && METHODS_ACCEPTING_HEAD_SHA.has(method) && !('headSha' in built)) {
    built.headSha = options.headSha
  }
  return built
}

// Keep the generic record-to-method assertion at this single boundary.
export function githubPrRequestParams<Method extends RpcMethodName>(
  method: Method,
  worktreeId: string,
  params: Record<string, unknown>,
  options?: GitHubPrParamOptions
): RpcSendParams<Method> {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the caller supplies the method's own declared fields; this adds only `repo`, and `prRepo`/`headSha` for the methods whose schema declares them.
  return buildGithubPrParams(method, worktreeId, params, options) as RpcSendParams<Method>
}
