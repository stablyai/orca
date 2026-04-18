import type { StatsSummary } from '../../shared/types';
import type { StatsEvent } from './types';
export declare function initStatsPath(): void;
export declare class StatsCollector {
    private events;
    private aggregates;
    private liveAgents;
    private writeTimer;
    constructor();
    record(event: StatsEvent): void;
    onAgentStart(ptyId: string, at: number, repoId?: string, worktreeId?: string): void;
    onAgentStop(ptyId: string, at: number): void;
    hasCountedPR(prUrl: string): boolean;
    getSummary(): StatsSummary;
    /**
     * Idempotent shutdown — closes out live agents and writes to disk.
     *
     * Why idempotent: Electron's before-quit can fire multiple times — the
     * updater handler calls event.preventDefault() to defer macOS installs.
     * We close live agents and write, but do NOT clear in-memory state so
     * a second flush() after resumed activity works correctly.
     */
    flush(): void;
    private load;
    private updateAggregates;
    private scheduleSave;
    private cancelPendingSave;
    private writeToDiskSync;
}
