import * as pty from 'node-pty';
import type { IPtyProvider, PtySpawnOptions, PtySpawnResult } from './types';
type DataCallback = (payload: {
    id: string;
    data: string;
}) => void;
type ExitCallback = (payload: {
    id: string;
    code: number;
}) => void;
export type LocalPtyProviderOptions = {
    buildSpawnEnv?: (id: string, baseEnv: Record<string, string>) => Record<string, string>;
    /** Whether worktree-scoped shell history is enabled. When true (or absent)
     *  and a worktreeId is provided, HISTFILE is scoped per-worktree. */
    isHistoryEnabled?: () => boolean;
    onSpawned?: (id: string) => void;
    onExit?: (id: string, code: number) => void;
    onData?: (id: string, data: string, timestamp: number) => void;
};
export declare class LocalPtyProvider implements IPtyProvider {
    private opts;
    constructor(opts?: LocalPtyProviderOptions);
    /** Reconfigure the provider with new hooks (e.g. after window re-creation). */
    configure(opts: LocalPtyProviderOptions): void;
    spawn(args: PtySpawnOptions): Promise<PtySpawnResult>;
    attach(_id: string): Promise<void>;
    write(id: string, data: string): void;
    resize(id: string, cols: number, rows: number): void;
    shutdown(id: string, _immediate: boolean): Promise<void>;
    sendSignal(id: string, signal: string): Promise<void>;
    getCwd(id: string): Promise<string>;
    getInitialCwd(_id: string): Promise<string>;
    clearBuffer(_id: string): Promise<void>;
    acknowledgeDataEvent(_id: string, _charCount: number): void;
    hasChildProcesses(id: string): Promise<boolean>;
    getForegroundProcess(id: string): Promise<string | null>;
    serialize(_ids: string[]): Promise<string>;
    revive(_state: string): Promise<void>;
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
    onData(callback: DataCallback): () => void;
    onReplay(_callback: (payload: {
        id: string;
        data: string;
    }) => void): () => void;
    onExit(callback: ExitCallback): () => void;
    /** Kill orphaned PTYs from previous page loads. */
    killOrphanedPtys(currentGeneration: number): {
        id: string;
    }[];
    /** Advance the load generation counter (called on renderer reload). */
    advanceGeneration(): number;
    /** Get a writable reference to a PTY (for runtime controller). */
    getPtyProcess(id: string): pty.IPty | undefined;
    /** Kill all PTYs. Call on app quit. */
    killAll(): void;
}
export {};
