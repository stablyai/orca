import type { Repo } from '../../shared/types';
import type { CodexUsageAttributedEvent, CodexUsageDailyAggregate, CodexUsageLocationBreakdown, CodexUsageParsedEvent, CodexUsagePersistedFile, CodexUsageProcessedFile, CodexUsageSession } from './types';
export type CodexUsageWorktreeRef = {
    repoId: string;
    worktreeId: string;
    path: string;
    displayName: string;
};
type CodexUsageRawUsage = {
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    reasoningOutputTokens: number;
    totalTokens: number;
};
type CodexUsageParseContext = {
    sessionId: string;
    sessionCwd: string | null;
    currentCwd: string | null;
    currentModel: string | null;
    previousTotals: CodexUsageRawUsage | null;
};
export declare function getCodexSessionsDirectory(): string;
export declare function listCodexSessionFiles(): Promise<string[]>;
export declare function getProcessedFileInfo(filePath: string): Promise<CodexUsageProcessedFile>;
export declare function attributeCodexUsageEvent(event: CodexUsageParsedEvent, worktrees: (CodexUsageWorktreeRef & {
    canonicalPath: string;
})[]): Promise<CodexUsageAttributedEvent | null>;
export declare function parseCodexUsageRecord(line: string, context: CodexUsageParseContext): CodexUsageParsedEvent | null;
export declare function parseCodexUsageFile(filePath: string, worktrees: (CodexUsageWorktreeRef & {
    canonicalPath: string;
})[]): Promise<CodexUsagePersistedFile>;
export declare function scanCodexUsageFiles(worktrees: CodexUsageWorktreeRef[], previousProcessedFiles: CodexUsagePersistedFile[]): Promise<{
    processedFiles: CodexUsagePersistedFile[];
    sessions: CodexUsageSession[];
    dailyAggregates: CodexUsageDailyAggregate[];
}>;
export declare function createWorktreeRefs(repos: Repo[], worktreesByRepo: Map<string, {
    path: string;
    worktreeId: string;
    displayName: string;
}[]>): CodexUsageWorktreeRef[];
export declare function getDefaultWorktreeLabel(pathValue: string): string;
export declare function getSessionProjectLabel(locationBreakdown: CodexUsageLocationBreakdown[]): string;
export {};
