/**
 * Git exec argument validation for the relay's git.exec handler.
 *
 * Why: oxlint max-lines requires files to stay under 300 lines.
 * Extracted from git-handler-ops.ts to keep both files under the limit.
 */
// Why: only read-only git subcommands are allowed via exec. config is restricted
// to read-only flags; branch rejects destructive flags; fetch/worktree removed.
const ALLOWED_GIT_SUBCOMMANDS = new Set([
    'rev-parse',
    'branch',
    'log',
    'show-ref',
    'ls-remote',
    'remote',
    'symbolic-ref',
    'merge-base',
    'ls-files',
    'config'
]);
const CONFIG_READ_ONLY_FLAGS = new Set(['--get', '--get-all', '--list', '--get-regexp', '-l']);
// Why: checking presence of a read-only flag is insufficient — a request could
// include both --list (passes the check) and --add (performs a write). Reject
// known write operations explicitly.
const CONFIG_WRITE_FLAGS = new Set([
    '--add',
    '--unset',
    '--unset-all',
    '--replace-all',
    '--rename-section',
    '--remove-section',
    '--edit',
    '-e',
    // Why: --file redirects config reads to an arbitrary file, enabling path
    // traversal (e.g. `--file /etc/passwd --list` leaks file contents).
    '--file',
    '-f',
    '--global',
    '--system'
]);
const BRANCH_DESTRUCTIVE_FLAGS = new Set([
    '-d',
    '-D',
    '--delete',
    '-m',
    '-M',
    '--move',
    '-c',
    '-C',
    '--copy'
]);
// Why: these flags are dangerous across ALL subcommands — --output writes to
// arbitrary paths, --exec-path changes where git loads helpers from, --work-tree
// and --git-dir escape the validated worktree.
const GLOBAL_DENIED_FLAGS = new Set(['--output', '-o', '--exec-path', '--work-tree', '--git-dir']);
const REMOTE_WRITE_SUBCOMMANDS = new Set([
    'add',
    'remove',
    'rm',
    'rename',
    'set-head',
    'set-branches',
    'set-url',
    'prune',
    'update'
]);
const SYMBOLIC_REF_WRITE_FLAGS = new Set(['-d', '--delete', '-m']);
// Why: git accepts --flag=value compound syntax (e.g. --file=/etc/passwd),
// which bypasses exact-match Set.has() checks. This helper catches both forms.
function matchesDeniedFlag(arg, denySet) {
    if (denySet.has(arg)) {
        return true;
    }
    const eqIdx = arg.indexOf('=');
    if (eqIdx > 0) {
        return denySet.has(arg.slice(0, eqIdx));
    }
    return false;
}
export function validateGitExecArgs(args) {
    // Why: git accepts `-c key=value` before the subcommand, which can override
    // config and execute arbitrary commands (e.g. core.sshCommand). Reject any
    // arguments before the subcommand that look like global git flags.
    let subcommandIdx = 0;
    while (subcommandIdx < args.length && args[subcommandIdx].startsWith('-')) {
        subcommandIdx++;
    }
    if (subcommandIdx > 0) {
        throw new Error('Global git flags before the subcommand are not allowed');
    }
    const subcommand = args[0];
    if (!subcommand || !ALLOWED_GIT_SUBCOMMANDS.has(subcommand)) {
        throw new Error(`git subcommand not allowed: ${subcommand ?? '(empty)'}`);
    }
    const restArgs = args.slice(1);
    if (restArgs.some((a) => matchesDeniedFlag(a, GLOBAL_DENIED_FLAGS))) {
        throw new Error('Dangerous git flags are not allowed via exec');
    }
    if (subcommand === 'config') {
        if (!restArgs.some((a) => CONFIG_READ_ONLY_FLAGS.has(a))) {
            throw new Error('git config is restricted to read-only operations (--get, --list, etc.)');
        }
        if (restArgs.some((a) => matchesDeniedFlag(a, CONFIG_WRITE_FLAGS))) {
            throw new Error('git config write operations are not allowed via exec');
        }
    }
    if (subcommand === 'branch') {
        if (restArgs.some((a) => matchesDeniedFlag(a, BRANCH_DESTRUCTIVE_FLAGS))) {
            throw new Error('Destructive git branch flags are not allowed via exec');
        }
    }
    if (subcommand === 'remote') {
        const remoteSubcmd = restArgs.find((a) => !a.startsWith('-'));
        if (remoteSubcmd && REMOTE_WRITE_SUBCOMMANDS.has(remoteSubcmd)) {
            throw new Error('Destructive git remote operations are not allowed via exec');
        }
    }
    if (subcommand === 'symbolic-ref') {
        if (restArgs.some((a) => matchesDeniedFlag(a, SYMBOLIC_REF_WRITE_FLAGS))) {
            throw new Error('git symbolic-ref write operations are not allowed via exec');
        }
        const positionalArgs = restArgs.filter((a) => !a.startsWith('-'));
        if (positionalArgs.length >= 2) {
            throw new Error('git symbolic-ref write operations are not allowed via exec');
        }
    }
}
