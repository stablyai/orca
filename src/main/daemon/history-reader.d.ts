export type ColdRestoreInfo = {
    scrollback: string;
    cwd: string;
    cols: number;
    rows: number;
};
export declare class HistoryReader {
    private basePath;
    constructor(basePath: string);
    detectColdRestore(sessionId: string): ColdRestoreInfo | null;
    listRestorable(): string[];
    private readMeta;
    private readScrollback;
    private truncateAltScreen;
}
