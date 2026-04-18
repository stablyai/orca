import type { GitHubPRFile, GitHubPRFileContents, GitHubWorkItemDetails } from '../../shared/types';
export declare function getWorkItemDetails(repoPath: string, number: number): Promise<GitHubWorkItemDetails | null>;
export declare function getPRFileContents(args: {
    repoPath: string;
    prNumber: number;
    path: string;
    oldPath?: string;
    status: GitHubPRFile['status'];
    headSha: string;
    baseSha: string;
}): Promise<GitHubPRFileContents>;
