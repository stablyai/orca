import type { SearchOptions, SearchResult } from '../../shared/types';
/**
 * Fallback text search using git grep. Used when rg is not available.
 *
 * Why: On Linux, rg may not be installed or may not be in PATH when the app
 * is launched from a desktop entry (which inherits a minimal system PATH).
 * git grep is always available since this is a git-focused app.
 */
export declare function searchWithGitGrep(rootPath: string, args: SearchOptions, maxResults: number): Promise<SearchResult>;
