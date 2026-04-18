import type { CreateWorktreeResult, Repo } from '../../shared/types';
import type { RuntimeRepoSearchRefs, RuntimeTerminalRead, RuntimeTerminalSend, RuntimeTerminalListResult, RuntimeStatus, RuntimeTerminalWait, RuntimeWorktreePsSummary, RuntimeTerminalShow, RuntimeSyncWindowGraph, RuntimeWorktreeListResult } from '../../shared/runtime-types';
import type { Store } from '../persistence';
import type { StatsCollector } from '../stats/collector';
type RuntimeStore = {
    getRepos: Store['getRepos'];
    getRepo: Store['getRepo'];
    addRepo: Store['addRepo'];
    updateRepo: Store['updateRepo'];
    getAllWorktreeMeta: Store['getAllWorktreeMeta'];
    getWorktreeMeta: Store['getWorktreeMeta'];
    setWorktreeMeta: Store['setWorktreeMeta'];
    removeWorktreeMeta: Store['removeWorktreeMeta'];
    getSettings(): {
        workspaceDir: string;
        nestWorkspaces: boolean;
        refreshLocalBaseRefOnWorktreeCreate: boolean;
        branchPrefix: string;
        branchPrefixCustom: string;
    };
};
type RuntimePtyController = {
    write(ptyId: string, data: string): boolean;
    kill(ptyId: string): boolean;
};
type RuntimeNotifier = {
    worktreesChanged(repoId: string): void;
    reposChanged(): void;
    activateWorktree(repoId: string, worktreeId: string, setup?: CreateWorktreeResult['setup']): void;
};
type ResolvedWorktree = {
    id: string;
    repoId: string;
    path: string;
    branch: string;
    linkedIssue: number | null;
    git: {
        path: string;
        head: string;
        branch: string;
        isBare: boolean;
        isMainWorktree: boolean;
    };
    displayName: string;
    comment: string;
};
export declare class OrcaRuntimeService {
    private readonly runtimeId;
    private readonly startedAt;
    private readonly store;
    private rendererGraphEpoch;
    private graphStatus;
    private authoritativeWindowId;
    private tabs;
    private leaves;
    private handles;
    private handleByLeafKey;
    private waitersByHandle;
    private ptyController;
    private notifier;
    private resolvedWorktreeCache;
    private agentDetector;
    constructor(store?: RuntimeStore | null, stats?: StatsCollector);
    getRuntimeId(): string;
    getStartedAt(): number;
    getStatus(): RuntimeStatus;
    setPtyController(controller: RuntimePtyController | null): void;
    setNotifier(notifier: RuntimeNotifier | null): void;
    attachWindow(windowId: number): void;
    syncWindowGraph(windowId: number, graph: RuntimeSyncWindowGraph): RuntimeStatus;
    onPtySpawned(ptyId: string): void;
    onPtyData(ptyId: string, data: string, at: number): void;
    onPtyExit(ptyId: string, exitCode: number): void;
    listTerminals(worktreeSelector?: string, limit?: number): Promise<RuntimeTerminalListResult>;
    showTerminal(handle: string): Promise<RuntimeTerminalShow>;
    readTerminal(handle: string): Promise<RuntimeTerminalRead>;
    sendTerminal(handle: string, action: {
        text?: string;
        enter?: boolean;
        interrupt?: boolean;
    }): Promise<RuntimeTerminalSend>;
    waitForTerminal(handle: string, options?: {
        timeoutMs?: number;
    }): Promise<RuntimeTerminalWait>;
    getWorktreePs(limit?: number): Promise<{
        worktrees: RuntimeWorktreePsSummary[];
        totalCount: number;
        truncated: boolean;
    }>;
    listRepos(): Repo[];
    addRepo(path: string, kind?: 'git' | 'folder'): Promise<Repo>;
    showRepo(repoSelector: string): Promise<Repo>;
    setRepoBaseRef(repoSelector: string, baseRef: string): Promise<Repo>;
    searchRepoRefs(repoSelector: string, query: string, limit?: number): Promise<RuntimeRepoSearchRefs>;
    listManagedWorktrees(repoSelector?: string, limit?: number): Promise<RuntimeWorktreeListResult>;
    showManagedWorktree(worktreeSelector: string): Promise<ResolvedWorktree>;
    createManagedWorktree(args: {
        repoSelector: string;
        name: string;
        baseBranch?: string;
        linkedIssue?: number | null;
        comment?: string;
    }): Promise<CreateWorktreeResult>;
    updateManagedWorktreeMeta(worktreeSelector: string, updates: {
        displayName?: string;
        linkedIssue?: number | null;
        comment?: string;
    }): Promise<import("../../shared/types").Worktree>;
    removeManagedWorktree(worktreeSelector: string, force?: boolean): Promise<void>;
    stopTerminalsForWorktree(worktreeSelector: string): Promise<{
        stopped: number;
    }>;
    markRendererReloading(windowId: number): void;
    markGraphReady(windowId: number): void;
    markGraphUnavailable(windowId: number): void;
    private assertGraphReady;
    private captureReadyGraphEpoch;
    private assertStableReadyGraph;
    private resolveWorktreeSelector;
    private resolveRepoSelector;
    private listResolvedWorktrees;
    private getResolvedWorktreeMap;
    private invalidateResolvedWorktreeCache;
    private buildTerminalSummary;
    private getLiveLeafForHandle;
    private issueHandle;
    private refreshWritableFlags;
    private invalidateLeafHandle;
    private resolveExitWaiters;
    private resolveWaiter;
    private rejectWaitersForHandle;
    private rejectAllWaiters;
    private removeWaiter;
    private getLeafKey;
}
export {};
