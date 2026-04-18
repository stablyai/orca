export type StatsEventType = 'agent_start' | 'agent_stop' | 'pr_created';
export type StatsEvent = {
    type: StatsEventType;
    at: number;
    repoId?: string;
    worktreeId?: string;
    meta?: Record<string, string | number>;
};
export type StatsAggregates = {
    totalAgentsSpawned: number;
    totalPRsCreated: number;
    totalAgentTimeMs: number;
    countedPRs: string[];
    firstEventAt: number | null;
};
export type StatsFile = {
    schemaVersion: number;
    events: StatsEvent[];
    aggregates: StatsAggregates;
};
