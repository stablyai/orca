import type { OrcaHooks, Repo, SetupDecision, SetupRunPolicy, WorktreeSetupLaunch } from '../shared/types';
/**
 * Parse a simple orca.yaml file. Handles only the supported `scripts:` and
 * `issueCommand:` keys with multiline string values (YAML block scalar `|`).
 */
export declare function parseOrcaYaml(content: string): OrcaHooks | null;
/**
 * Load hooks from orca.yaml in the given repo root.
 */
export declare function loadHooks(repoPath: string): OrcaHooks | null;
/**
 * Check whether an orca.yaml exists for a repo.
 */
export declare function hasHooksFile(repoPath: string): boolean;
/**
 * Return true when `orca.yaml` contains at least one top-level key that this
 * version of Orca does not handle.
 */
export declare function hasUnrecognizedOrcaYamlKeys(repoPath: string): boolean;
export declare function getIssueCommandFilePath(repoPath: string): string;
export declare function getSharedIssueCommand(repoPath: string): string | null;
export type ResolvedIssueCommand = {
    localContent: string | null;
    sharedContent: string | null;
    effectiveContent: string | null;
    localFilePath: string;
    source: 'local' | 'shared' | 'none';
};
/**
 * Resolve the GitHub issue command using local override first, then tracked repo config.
 */
export declare function readIssueCommand(repoPath: string): ResolvedIssueCommand;
/**
 * Write the per-user issue command override to `{repoRoot}/.orca/issue-command`.
 * Creates `.orca/` and ensures it is in `.gitignore` on first write.
 * If content is empty, deletes only the override so the shared `orca.yaml`
 * command becomes effective again.
 */
export declare function writeIssueCommand(repoPath: string, content: string): void;
export declare function getEffectiveHooks(repo: Repo): OrcaHooks | null;
export declare function getEffectiveSetupRunPolicy(repo: Repo): SetupRunPolicy;
export declare function shouldRunSetupForCreate(repo: Repo, decision?: SetupDecision): boolean;
export declare function getSetupCommandSource(repo: Repo): {
    source: 'yaml';
    command: string;
} | null;
export declare function createSetupRunnerScript(repo: Repo, worktreePath: string, script: string): WorktreeSetupLaunch;
export declare function createIssueCommandRunnerScript(repo: Repo, worktreePath: string, command: string): WorktreeSetupLaunch;
/**
 * Run a named hook script in the given working directory.
 */
export declare function runHook(hookName: 'setup' | 'archive', cwd: string, repo: Repo): Promise<{
    success: boolean;
    output: string;
}>;
