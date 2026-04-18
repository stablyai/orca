import { type SubprocessHandle } from './session';
import type { SessionInfo, TerminalSnapshot, ShellReadyState } from './types';
export type CreateOrAttachOptions = {
    sessionId: string;
    cols: number;
    rows: number;
    cwd?: string;
    env?: Record<string, string>;
    command?: string;
    shellReadySupported?: boolean;
    streamClient: {
        onData: (data: string) => void;
        onExit: (code: number) => void;
    };
};
export type CreateOrAttachResult = {
    isNew: boolean;
    snapshot: TerminalSnapshot | null;
    pid: number | null;
    shellState: ShellReadyState;
    attachToken: symbol;
};
export type TerminalHostOptions = {
    spawnSubprocess: (opts: {
        sessionId: string;
        cols: number;
        rows: number;
        cwd?: string;
        env?: Record<string, string>;
        command?: string;
    }) => SubprocessHandle;
};
export declare class TerminalHost {
    private sessions;
    private killedTombstones;
    private spawnSubprocess;
    constructor(opts: TerminalHostOptions);
    createOrAttach(opts: CreateOrAttachOptions): Promise<CreateOrAttachResult>;
    write(sessionId: string, data: string): void;
    resize(sessionId: string, cols: number, rows: number): void;
    kill(sessionId: string): void;
    signal(sessionId: string, sig: string): void;
    detach(sessionId: string, token: symbol): void;
    getCwd(sessionId: string): string | null;
    clearScrollback(sessionId: string): void;
    isKilled(sessionId: string): boolean;
    listSessions(): SessionInfo[];
    dispose(): void;
    private getAliveSession;
    private recordTombstone;
}
