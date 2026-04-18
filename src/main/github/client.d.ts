import type { PRInfo, PRCheckDetail, PRComment, GitHubViewer, GitHubWorkItem } from '../../shared/types';
export { _resetOwnerRepoCache } from './gh-utils';
export { getIssue, listIssues } from './issues';
/**
 * Check if the authenticated user has starred the Orca repo.
 * Returns true if starred, false if not, null if unable to determine (gh unavailable).
 */
export declare function checkOrcaStarred(): Promise<boolean | null>;
/**
 * Star the Orca repo for the authenticated user.
 */
export declare function starOrca(): Promise<boolean>;
/**
 * Get the authenticated GitHub viewer when gh is available and logged in.
 * Returns null when gh is unavailable, unauthenticated, or the lookup fails.
 */
export declare function getAuthenticatedViewer(): Promise<GitHubViewer | null>;
export declare function listWorkItems(repoPath: string, limit?: number, query?: string): Promise<GitHubWorkItem[]>;
export declare function getRepoSlug(repoPath: string): Promise<{
    owner: string;
    repo: string;
} | null>;
export declare function getWorkItem(repoPath: string, number: number): Promise<GitHubWorkItem | null>;
/**
 * Get PR info for a given branch using gh CLI.
 * Returns null if gh is not installed, or no PR exists for the branch.
 */
export declare function getPRForBranch(repoPath: string, branch: string): Promise<PRInfo | null>;
/**
 * Get detailed check statuses for a PR.
 * When branch is provided, uses gh api --cache with the check-runs REST endpoint
 * so 304 Not Modified responses don't count against the rate limit.
 */
export declare function getPRChecks(repoPath: string, prNumber: number, headSha?: string, options?: {
    noCache?: boolean;
}): Promise<PRCheckDetail[]>;
/**
 * Get all comments on a PR — both top-level conversation comments and inline
 * review comments (including suggestions). Uses GraphQL for review threads
 * to get resolution status, REST for issue-level comments.
 */
export declare function getPRComments(repoPath: string, prNumber: number, options?: {
    noCache?: boolean;
}): Promise<PRComment[]>;
/**
 * Resolve or unresolve a PR review thread via GraphQL.
 */
export declare function resolveReviewThread(repoPath: string, threadId: string, resolve: boolean): Promise<boolean>;
/**
 * Merge a PR by number using gh CLI.
 * method: 'merge' | 'squash' | 'rebase' (default: 'squash')
 */
export declare function mergePR(repoPath: string, prNumber: number, method?: 'merge' | 'squash' | 'rebase'): Promise<{
    ok: true;
} | {
    ok: false;
    error: string;
}>;
/**
 * Update a PR's title.
 */
export declare function updatePRTitle(repoPath: string, prNumber: number, title: string): Promise<boolean>;
