import type { PRConflictSummary } from '../../shared/types';
export declare function getPRConflictSummary(repoPath: string, baseRefName: string, baseRefOid: string, headRefOid: string): Promise<PRConflictSummary | undefined>;
