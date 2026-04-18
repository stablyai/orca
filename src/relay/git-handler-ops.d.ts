export type GitExec = (args: string[], cwd: string) => Promise<{
    stdout: string;
    stderr: string;
}>;
export type GitBufferExec = (args: string[], cwd: string) => Promise<Buffer>;
export declare function readBlobAtOid(gitBuffer: GitBufferExec, cwd: string, oid: string, filePath: string): Promise<{
    content: string;
    isBinary: boolean;
}>;
export declare function readBlobAtIndex(gitBuffer: GitBufferExec, cwd: string, filePath: string): Promise<{
    content: string;
    isBinary: boolean;
}>;
export declare function readUnstagedLeft(gitBuffer: GitBufferExec, cwd: string, filePath: string): Promise<{
    content: string;
    isBinary: boolean;
}>;
export declare function readWorkingFile(absPath: string): Promise<{
    content: string;
    isBinary: boolean;
}>;
export declare function computeDiff(git: GitBufferExec, worktreePath: string, filePath: string, staged: boolean): Promise<{
    isImage?: boolean | undefined;
    mimeType?: string | undefined;
    kind: "binary";
    originalContent: string;
    modifiedContent: string;
    originalIsBinary: boolean;
    modifiedIsBinary: boolean;
} | {
    kind: "text";
    originalContent: string;
    modifiedContent: string;
    originalIsBinary: boolean;
    modifiedIsBinary: boolean;
}>;
export declare function branchCompare(git: GitExec, worktreePath: string, baseRef: string, loadBranchChanges: (mergeBase: string, headOid: string) => Promise<Record<string, unknown>[]>): Promise<{
    summary: Record<string, unknown>;
    entries: Record<string, unknown>[];
}>;
export declare function branchDiffEntries(git: GitExec, gitBuffer: GitBufferExec, worktreePath: string, baseRef: string, opts: {
    includePatch?: boolean;
    filePath?: string;
    oldPath?: string;
}): Promise<Record<string, unknown>[] | {
    kind: string;
    originalContent: string;
    modifiedContent: string;
    originalIsBinary: boolean;
    modifiedIsBinary: boolean;
}[]>;
export { validateGitExecArgs } from './git-exec-validator';
