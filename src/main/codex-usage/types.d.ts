export type CodexUsageProcessedFile = {
    path: string;
    mtimeMs: number;
    size: number;
};
export type CodexUsageLocationBreakdown = {
    locationKey: string;
    projectLabel: string;
    repoId: string | null;
    worktreeId: string | null;
    eventCount: number;
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    reasoningOutputTokens: number;
    totalTokens: number;
    hasInferredPricing: boolean;
};
export type CodexUsageModelBreakdown = {
    modelKey: string;
    modelLabel: string;
    hasInferredPricing: boolean;
    eventCount: number;
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    reasoningOutputTokens: number;
    totalTokens: number;
};
export type CodexUsageLocationModelBreakdown = {
    locationKey: string;
    modelKey: string;
    modelLabel: string;
    repoId: string | null;
    worktreeId: string | null;
    eventCount: number;
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    reasoningOutputTokens: number;
    totalTokens: number;
    hasInferredPricing: boolean;
};
export type CodexUsageSession = {
    sessionId: string;
    firstTimestamp: string;
    lastTimestamp: string;
    primaryModel: string | null;
    hasMixedModels: boolean;
    primaryProjectLabel: string;
    hasMixedLocations: boolean;
    primaryWorktreeId: string | null;
    primaryRepoId: string | null;
    eventCount: number;
    totalInputTokens: number;
    totalCachedInputTokens: number;
    totalOutputTokens: number;
    totalReasoningOutputTokens: number;
    totalTokens: number;
    hasInferredPricing: boolean;
    locationBreakdown: CodexUsageLocationBreakdown[];
    modelBreakdown: CodexUsageModelBreakdown[];
    locationModelBreakdown: CodexUsageLocationModelBreakdown[];
};
export type CodexUsageDailyAggregate = {
    day: string;
    model: string | null;
    projectKey: string;
    projectLabel: string;
    repoId: string | null;
    worktreeId: string | null;
    eventCount: number;
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    reasoningOutputTokens: number;
    totalTokens: number;
    hasInferredPricing: boolean;
};
export type CodexUsagePersistedFile = CodexUsageProcessedFile & {
    sessions: CodexUsageSession[];
    dailyAggregates: CodexUsageDailyAggregate[];
};
export type CodexUsagePersistedState = {
    schemaVersion: number;
    worktreeFingerprint: string | null;
    processedFiles: CodexUsagePersistedFile[];
    sessions: CodexUsageSession[];
    dailyAggregates: CodexUsageDailyAggregate[];
    scanState: {
        enabled: boolean;
        lastScanStartedAt: number | null;
        lastScanCompletedAt: number | null;
        lastScanError: string | null;
    };
};
export type CodexUsageParsedEvent = {
    sessionId: string;
    timestamp: string;
    model: string | null;
    cwd: string | null;
    hasInferredPricing: boolean;
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    reasoningOutputTokens: number;
    totalTokens: number;
};
export type CodexUsageAttributedEvent = CodexUsageParsedEvent & {
    day: string;
    projectKey: string;
    projectLabel: string;
    repoId: string | null;
    worktreeId: string | null;
};
