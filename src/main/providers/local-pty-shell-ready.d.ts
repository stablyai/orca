import type * as pty from 'node-pty';
declare const STARTUP_COMMAND_READY_MAX_WAIT_MS = 1500;
export type ShellReadyScanState = {
    matchPos: number;
    heldBytes: string;
};
export declare function createShellReadyScanState(): ShellReadyScanState;
export declare function scanForShellReady(state: ShellReadyScanState, data: string): {
    output: string;
    matched: boolean;
};
export declare function getBashShellReadyRcfileContent(): string;
export type ShellReadyLaunchConfig = {
    args: string[] | null;
    env: Record<string, string>;
    supportsReadyMarker: boolean;
};
export declare function getShellReadyLaunchConfig(shellPath: string): ShellReadyLaunchConfig;
export declare function writeStartupCommandWhenShellReady(readyPromise: Promise<void>, proc: pty.IPty, startupCommand: string, onExit: (cleanup: () => void) => void): void;
export { STARTUP_COMMAND_READY_MAX_WAIT_MS };
