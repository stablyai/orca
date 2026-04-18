import type { IssueInfo } from '../../shared/types';
/**
 * Get a single issue by number.
 * Uses gh api --cache so 304 Not Modified responses don't count against the rate limit.
 */
export declare function getIssue(repoPath: string, issueNumber: number): Promise<IssueInfo | null>;
/**
 * List issues for a repo.
 * Uses gh api --cache so 304 Not Modified responses don't count against the rate limit.
 */
export declare function listIssues(repoPath: string, limit?: number): Promise<IssueInfo[]>;
