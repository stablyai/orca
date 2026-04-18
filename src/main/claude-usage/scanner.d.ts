import type { Repo } from '../../shared/types';
import type { ClaudeUsageAttributedTurn, ClaudeUsageDailyAggregate, ClaudeUsageLocationBreakdown, ClaudeUsageParsedTurn, ClaudeUsageProcessedFile, ClaudeUsageSession } from './types';
export type ClaudeUsageWorktreeRef = {
    repoId: string;
    worktreeId: string;
    path: string;
    displayName: string;
};
export declare function listClaudeTranscriptFiles(): Promise<string[]>;
export declare function getProcessedFileInfo(filePath: string): Promise<ClaudeUsageProcessedFile>;
export declare function parseClaudeUsageRecord(line: string): ClaudeUsageParsedTurn | null;
export declare function parseClaudeUsageFile(filePath: string): Promise<ClaudeUsageParsedTurn[]>;
export declare function buildWorktreeLookup(worktrees: ClaudeUsageWorktreeRef[]): Promise<Map<string, ClaudeUsageWorktreeRef>>;
export declare function attributeClaudeUsageTurns(turns: ClaudeUsageParsedTurn[], worktreeLookup: Map<string, ClaudeUsageWorktreeRef>): Promise<ClaudeUsageAttributedTurn[]>;
export declare function aggregateClaudeUsage(turns: ClaudeUsageAttributedTurn[]): {
    sessions: ClaudeUsageSession[];
    dailyAggregates: ClaudeUsageDailyAggregate[];
};
export declare function scanClaudeUsageFiles(worktrees: ClaudeUsageWorktreeRef[]): Promise<{
    processedFiles: ClaudeUsageProcessedFile[];
    sessions: ClaudeUsageSession[];
    dailyAggregates: ClaudeUsageDailyAggregate[];
}>;
export declare function getClaudeProjectsDirectory(): string;
export declare function createWorktreeRefs(repos: Repo[], worktreesByRepo: Map<string, {
    path: string;
    worktreeId: string;
    displayName: string;
}[]>): ClaudeUsageWorktreeRef[];
export declare function getSessionProjectLabel(locationBreakdown: ClaudeUsageLocationBreakdown[]): string;
export declare function getDefaultWorktreeLabel(pathValue: string): string;
