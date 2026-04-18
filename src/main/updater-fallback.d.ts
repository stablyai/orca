import type { UpdateStatus } from '../shared/types';
export declare function statusesEqual(left: UpdateStatus, right: UpdateStatus): boolean;
export declare function isGitHubReleaseTransitionFailure(normalizedMessage: string): boolean;
/** Identifies update-check failures that are transient or infrastructure-related
 *  (e.g. network blips, GitHub release transitions) and should NOT be surfaced
 *  to the user as errors. */
export declare function isBenignCheckFailure(message: string): boolean;
export declare function isValidVersion(value: string): boolean;
/** Returns negative if left < right, 0 if equal, positive if left > right. */
export declare function compareVersions(left: string, right: string): number;
