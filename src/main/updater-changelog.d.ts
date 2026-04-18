import type { ChangelogData } from '../shared/types';
/**
 * Fetches the remote changelog and finds the best entry to show the user.
 *
 * 1. If the incoming version has an exact match with rich content, use it.
 * 2. Otherwise, find the most recent entry that has rich content. If the user's
 *    local version is behind that entry, show it anyway — demoing an older
 *    highlight is better than showing nothing. In this fallback case the
 *    release notes link points to the generic changelog page instead of a
 *    version-specific URL.
 *
 * Why net.fetch instead of fetch: Electron's `net` module respects the app's
 * proxy/certificate settings and has no CORS restrictions.
 */
export declare function fetchChangelog(incomingVersion: string, localVersion: string): Promise<ChangelogData | null>;
