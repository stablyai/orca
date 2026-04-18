export declare const MAX_FILE_SIZE: number;
export declare const SEARCH_TIMEOUT_MS = 15000;
export declare const MAX_MATCHES_PER_FILE = 100;
export declare const DEFAULT_MAX_RESULTS = 2000;
export declare const IMAGE_MIME_TYPES: Record<string, string>;
export declare function isBinaryBuffer(buffer: Buffer): boolean;
export type SearchOptions = {
    caseSensitive?: boolean;
    wholeWord?: boolean;
    useRegex?: boolean;
    includePattern?: string;
    excludePattern?: string;
    maxResults: number;
};
type FileResult = {
    filePath: string;
    relativePath: string;
    matches: {
        line: number;
        column: number;
        matchLength: number;
        lineContent: string;
    }[];
};
export type SearchResult = {
    files: FileResult[];
    totalMatches: number;
    truncated: boolean;
};
/**
 * Run ripgrep (`rg`) with JSON output to collect text matches.
 * Returns a structured result that the relay can send to the client.
 */
export declare function searchWithRg(rootPath: string, query: string, opts: SearchOptions): Promise<SearchResult>;
/**
 * List all non-ignored files under `rootPath` using ripgrep's `--files` mode.
 * Returns relative POSIX paths.
 */
export declare function listFilesWithRg(rootPath: string): Promise<string[]>;
export {};
