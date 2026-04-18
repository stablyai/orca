import { HistoryManager } from './history-manager';
import type { IPtyProvider, PtySpawnOptions, PtySpawnResult } from '../providers/types';
export type DaemonPtyAdapterOptions = {
    socketPath: string;
    tokenPath: string;
    /** Directory for disk-based terminal history. When set, the adapter writes
     *  raw PTY output to disk for cold restore on daemon crash. */
    historyPath?: string;
};
export declare class TerminalKilledError extends Error {
    constructor(sessionId: string);
}
export declare class DaemonPtyAdapter implements IPtyProvider {
    private client;
    private historyManager;
    private historyReader;
    private dataListeners;
    private exitListeners;
    private removeEventListener;
    private initialCwds;
    private killedSessionTombstones;
    private coldRestoreCache;
    constructor(opts: DaemonPtyAdapterOptions);
    getHistoryManager(): HistoryManager | null;
    spawn(opts: PtySpawnOptions): Promise<PtySpawnResult>;
    attach(id: string): Promise<void>;
    write(id: string, data: string): void;
    resize(id: string, cols: number, rows: number): void;
    shutdown(id: string, _immediate: boolean): Promise<void>;
    ackColdRestore(sessionId: string): void;
    clearTombstone(sessionId: string): void;
    sendSignal(id: string, signal: string): Promise<void>;
    getCwd(id: string): Promise<string>;
    getInitialCwd(id: string): Promise<string>;
    clearBuffer(id: string): Promise<void>;
    acknowledgeDataEvent(_id: string, _charCount: number): void;
    hasChildProcesses(_id: string): Promise<boolean>;
    getForegroundProcess(_id: string): Promise<string | null>;
    serialize(ids: string[]): Promise<string>;
    revive(_state: string): Promise<void>;
    /** Called on app launch. Lists daemon sessions, kills orphans whose
     *  workspaceId no longer exists, and caches alive session IDs. */
    reconcileOnStartup(validWorktreeIds: Set<string>): Promise<{
        alive: string[];
        killed: string[];
    }>;
    listProcesses(): Promise<{
        id: string;
        cwd: string;
        title: string;
    }[]>;
    getDefaultShell(): Promise<string>;
    getProfiles(): Promise<{
        name: string;
        path: string;
    }[]>;
    onData(callback: (payload: {
        id: string;
        data: string;
    }) => void): () => void;
    onReplay(_callback: (payload: {
        id: string;
        data: string;
    }) => void): () => void;
    onExit(callback: (payload: {
        id: string;
        code: number;
    }) => void): () => void;
    dispose(): void;
    disconnectOnly(): void;
    private ensureConnected;
    private setupEventRouting;
}
