export type SessionMeta = {
    cwd: string;
    cols: number;
    rows: number;
    startedAt: string;
    endedAt: string | null;
    exitCode: number | null;
};
export type OpenSessionOptions = {
    cwd: string;
    cols: number;
    rows: number;
    initialScrollback?: string;
};
export type HistoryManagerOptions = {
    onWriteError?: (sessionId: string, error: Error) => void;
};
export declare class HistoryManager {
    private basePath;
    private writers;
    private disabledSessions;
    private onWriteError?;
    constructor(basePath: string, opts?: HistoryManagerOptions);
    openSession(sessionId: string, opts: OpenSessionOptions): Promise<void>;
    appendData(sessionId: string, data: string): Promise<void>;
    closeSession(sessionId: string, exitCode: number): Promise<void>;
    removeSession(sessionId: string): Promise<void>;
    hasHistory(sessionId: string): boolean;
    readMeta(sessionId: string): SessionMeta | null;
    dispose(): Promise<void>;
    private writeChunk;
    private resetScrollback;
    private trailingPartialCsi3J;
    private extractLatestCwd;
    private parseOsc7Uri;
    private handleWriteError;
    private updateMeta;
}
