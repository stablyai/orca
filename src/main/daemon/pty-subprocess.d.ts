import type { SubprocessHandle } from './session';
export type PtySubprocessOptions = {
    sessionId: string;
    cols: number;
    rows: number;
    cwd?: string;
    env?: Record<string, string>;
    command?: string;
};
export declare function createPtySubprocess(opts: PtySubprocessOptions): SubprocessHandle;
