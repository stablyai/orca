import type { RpcMethodName, RpcSendParams } from '../transport/rpc-params-contract'
import { mobileRepoSelectorFromWorktreeId } from '../source-control/mobile-pr-create'

// Why: a fork PR's head lives in a different owner/repo; the host's SlugRepo
// (`{ owner, repo }`) identifies it. Only a subset of github.* methods accept it.
// Why: `host` must survive the RPC boundary or GHES actions on the host fall
// back to a same-named github.com repo (src/shared/types.ts identity contract).
export type GitHubPrRepoSlug = { owner: string; repo: string; host?: string }

export function githubPrRepoSlugParam(slug: GitHubPrRepoSlug): {
  owner: string
  repo: string
  host?: string
} {
  return { owner: slug.owner, repo: slug.repo, ...(slug.host ? { host: slug.host } : {}) }
}

// Why: `prRepo` remains method-asymmetric. Keep the RPC schema allow-list here
// so fork/GHES identity reaches every PR-scoped read or mutation that accepts it.
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

// Why: only github.prChecks declares a `headSha` param (PullRequestCheckDetails
// does not), so headSha is forwarded just to that read. Check runs are commit-keyed.
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

/**
 * The same record, presented as one method's send params — the single seam where the PR surface's
 * record-shaped builder meets the typed operations. The builder is method-generic and returns a
 * record, so it cannot be typed per method; one assertion here rather than one per wrapper.
 */
export function githubPrRequestParams<Method extends RpcMethodName>(
  method: Method,
  worktreeId: string,
  params: Record<string, unknown>,
  options?: GitHubPrParamOptions
): RpcSendParams<Method> {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the caller supplies the method's own declared fields; this adds only `repo`, and `prRepo`/`headSha` for the methods whose schema declares them.
  return buildGithubPrParams(method, worktreeId, params, options) as RpcSendParams<Method>
}
