/**
 * Git exec argument validation for the relay's git.exec handler.
 *
 * Why: oxlint max-lines requires files to stay under 300 lines.
 * Extracted from git-handler-ops.ts to keep both files under the limit.
 */
export declare function validateGitExecArgs(args: string[]): void;
