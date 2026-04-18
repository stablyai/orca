import type { CodexUsageBreakdownKind, CodexUsageBreakdownRow, CodexUsageDailyPoint, CodexUsageRange, CodexUsageScanState, CodexUsageScope, CodexUsageSessionRow, CodexUsageSummary } from '../../shared/codex-usage-types';
import type { Store } from '../persistence';
import type { CodexUsagePersistedState } from './types';
export declare function normalizePersistedState(state: CodexUsagePersistedState): CodexUsagePersistedState;
export declare function initCodexUsagePath(): void;
export declare class CodexUsageStore {
    private state;
    private readonly store;
    private scanPromise;
    constructor(store: Store);
    private load;
    private writeToDisk;
    setEnabled(enabled: boolean): Promise<CodexUsageScanState>;
    getScanState(): CodexUsageScanState;
    refresh(force?: boolean): Promise<CodexUsageScanState>;
    private runScan;
    getSummary(scope: CodexUsageScope, range: CodexUsageRange): Promise<CodexUsageSummary>;
    getDaily(scope: CodexUsageScope, range: CodexUsageRange): Promise<CodexUsageDailyPoint[]>;
    getBreakdown(scope: CodexUsageScope, range: CodexUsageRange, kind: CodexUsageBreakdownKind): Promise<CodexUsageBreakdownRow[]>;
    getRecentSessions(scope: CodexUsageScope, range: CodexUsageRange, limit?: number): Promise<CodexUsageSessionRow[]>;
    private getFilteredDaily;
    private getFilteredSessions;
    private getScopedSessionModels;
    private getScopedSessionPrimaryModel;
    private getCurrentWorktreeFingerprint;
    private loadWorktreesByRepo;
}
