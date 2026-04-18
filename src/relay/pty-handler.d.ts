import type { RelayDispatcher } from './dispatcher';
export declare const REPLAY_BUFFER_MAX: number;
export declare class PtyHandler {
    private ptys;
    private nextId;
    private dispatcher;
    private graceTimeMs;
    private graceTimer;
    constructor(dispatcher: RelayDispatcher, graceTimeMs?: number);
    /** Wire onData/onExit listeners for a managed PTY and store it. */
    private wireAndStore;
    private registerHandlers;
    private spawn;
    private attach;
    private writeData;
    private resize;
    private shutdown;
    private sendSignal;
    private getCwd;
    private getInitialCwd;
    private clearBuffer;
    private hasChildProcesses;
    private getForegroundProcess;
    private listProcesses;
    private serialize;
    private revive;
    startGraceTimer(onExpire: () => void): void;
    cancelGraceTimer(): void;
    dispose(): void;
    get activePtyCount(): number;
}
