import type {
  CreateHostedReviewInput,
  CreateHostedReviewResult,
  HostedReviewInfo
} from '../../shared/hosted-review'
import type { CustomGitServer } from '../../shared/custom-git-server'

/** A repository on a configured custom server: the matched server + its owner/repo. */
export type CustomGitServerRepoRef = {
  server: CustomGitServer
  owner: string
  repo: string
}

/** Result of verifying a token against a server. */
export type CustomGitServerVerifyResult = {
  /** Login/username, or null when authenticated but the account is unknown. */
  account: string | null
}

/**
 * The pluggable seam for a custom git server's API. Each API "flavor" (GitLab,
 * and later GitHub/Gitea/…) implements this once and is registered in
 * api-flavor.ts. Clients are pure: given a server + token they hit the REST API;
 * persistence and remote resolution live elsewhere.
 */
export type CustomGitServerFlavorClient = {
  /** Verify the token. Returns the account on success, null when invalid/unreachable. */
  verify(server: CustomGitServer, token: string): Promise<CustomGitServerVerifyResult | null>
  /** Review for a branch (by source branch, falling back to a linked number). */
  getReviewForBranch(
    ref: CustomGitServerRepoRef,
    token: string | null,
    branch: string,
    linkedNumber: number | null
  ): Promise<HostedReviewInfo | null>
  /** Review by its number/iid. */
  getReviewByNumber(
    ref: CustomGitServerRepoRef,
    token: string | null,
    number: number
  ): Promise<HostedReviewInfo | null>
  /** Open a new review (merge/pull request) for the given input. */
  createReview(
    ref: CustomGitServerRepoRef,
    token: string | null,
    input: CreateHostedReviewInput,
    repoPath: string,
    connectionId?: string | null
  ): Promise<CreateHostedReviewResult>
}
