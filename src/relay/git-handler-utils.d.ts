export declare function parseStatusChar(char: string): string;
export declare function parseBranchStatusChar(char: string): string;
export declare function parseConflictKind(xy: string): string | null;
/**
 * Parse `git status --porcelain=v2` output into structured entries.
 * Does NOT handle unmerged entries (those require worktree access).
 */
export declare function parseStatusOutput(stdout: string): {
    entries: Record<string, unknown>[];
    unmergedLines: string[];
};
/**
 * Parse a single unmerged entry line from porcelain v2 output.
 * Returns null if the entry should be skipped (e.g. submodule conflicts).
 */
export declare function parseUnmergedEntry(worktreePath: string, line: string): Record<string, unknown> | null;
/**
 * Parse `git diff --name-status` output into structured change entries.
 */
export declare function parseBranchDiff(stdout: string): Record<string, unknown>[];
export declare function parseWorktreeList(output: string): Record<string, unknown>[];
export declare function isBinaryBuffer(buffer: Buffer): boolean;
export declare const PREVIEWABLE_MIME: Record<string, string>;
export declare function bufferToBlob(buffer: Buffer, filePath?: string): {
    content: string;
    isBinary: boolean;
};
/**
 * Build a diff result object from original/modified content.
 * Used by both working-tree diffs and branch diffs.
 */
export declare function buildDiffResult(originalContent: string, modifiedContent: string, originalIsBinary: boolean, modifiedIsBinary: boolean, filePath?: string): {
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
};
