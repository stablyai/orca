import './xterm-env-polyfill';
import type { TerminalSnapshot } from './types';
export type HeadlessEmulatorOptions = {
    cols: number;
    rows: number;
    scrollback?: number;
    onData?: (data: string) => void;
};
export declare class HeadlessEmulator {
    private terminal;
    private serializer;
    private cwd;
    private disposed;
    constructor(opts: HeadlessEmulatorOptions);
    write(data: string): Promise<void>;
    resize(cols: number, rows: number): void;
    getSnapshot(): TerminalSnapshot;
    get isAlternateScreen(): boolean;
    getCwd(): string | null;
    clearScrollback(): void;
    dispose(): void;
    private scanOsc7;
    private parseOsc7Uri;
    private getModes;
    private buildRehydrateSequences;
}
