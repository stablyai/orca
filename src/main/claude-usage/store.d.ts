import type { ClaudeUsageBreakdownKind, ClaudeUsageBreakdownRow, ClaudeUsageDailyPoint, ClaudeUsageRange, ClaudeUsageScanState, ClaudeUsageScope, ClaudeUsageSessionRow, ClaudeUsageSummary } from '../../shared/claude-usage-types';
import type { Store } from '../persistence';
export declare function initClaudeUsagePath(): void;
export declare class ClaudeUsageStore {
    private state;
    private readonly store;
    private scanPromise;
    constructor(store: Store);
    private load;
    private writeToDisk;
    setEnabled(enabled: boolean): Promise<ClaudeUsageScanState>;
    getScanState(): ClaudeUsageScanState;
    refresh(force?: boolean): Promise<ClaudeUsageScanState>;
    private runScan;
    getSummary(scope: ClaudeUsageScope, range: ClaudeUsageRange): Promise<ClaudeUsageSummary>;
    getDaily(scope: ClaudeUsageScope, range: ClaudeUsageRange): Promise<ClaudeUsageDailyPoint[]>;
    getBreakdown(scope: ClaudeUsageScope, range: ClaudeUsageRange, kind: ClaudeUsageBreakdownKind): Promise<ClaudeUsageBreakdownRow[]>;
    getRecentSessions(scope: ClaudeUsageScope, range: ClaudeUsageRange, limit?: number): Promise<ClaudeUsageSessionRow[]>;
    private getFilteredDaily;
    private getFilteredSessions;
    private loadWorktreesByRepo;
}
