import { gitExecFileAsync } from '../git/runner';
export async function getPRConflictSummary(repoPath, baseRefName, baseRefOid, headRefOid) {
    try {
        // Why: the renderer only needs a read-only merge-conflict snapshot. We
        // derive it from local git state so the PR card can show GitHub-style
        // detail without spending additional gh API calls on every refresh. We use
        // GitHub's head OID directly because the registered repo path may not have
        // a matching local branch name for the PR head. For the base side, prefer a
        // freshly-fetched remote-tracking ref so Orca matches GitHub's portal,
        // which compares against the latest base branch tip rather than the PR's
        // older pinned baseRefOid snapshot.
        const latestBaseOid = await resolveLatestBaseOid(repoPath, baseRefName, baseRefOid);
        const mergeBase = await resolveMergeBase(repoPath, headRefOid, latestBaseOid);
        const [commitsBehind, files] = await Promise.all([
            countCommits(repoPath, `${headRefOid}..${latestBaseOid}`),
            loadConflictingFiles(repoPath, mergeBase, headRefOid, latestBaseOid)
        ]);
        return {
            baseRef: baseRefName,
            baseCommit: latestBaseOid.slice(0, 7),
            commitsBehind,
            files
        };
    }
    catch {
        return undefined;
    }
}
async function resolveLatestBaseOid(repoPath, baseRefName, fallbackBaseOid) {
    const remoteName = 'origin';
    try {
        // Why: cap the fetch at 10 s so slow or unreachable remotes don't block
        // the conflict-summary derivation indefinitely.
        await gitExecFileAsync(['fetch', '--quiet', remoteName, baseRefName], {
            cwd: repoPath,
            timeout: 10_000
        });
    }
    catch {
        // Why: fetching the base ref keeps the conflict list aligned with GitHub's
        // live mergeability view, but the card must still render offline. If fetch
        // fails, fall back to the base OID GitHub already gave us.
    }
    for (const ref of [`refs/remotes/${remoteName}/${baseRefName}`, `${remoteName}/${baseRefName}`]) {
        try {
            const { stdout } = await gitExecFileAsync(['rev-parse', '--verify', ref], {
                cwd: repoPath
            });
            const oid = stdout.trim();
            if (oid) {
                return oid;
            }
        }
        catch {
            // Try the next ref form before falling back to GitHub's baseRefOid.
        }
    }
    return fallbackBaseOid;
}
async function resolveMergeBase(repoPath, headOid, baseOid) {
    const { stdout } = await gitExecFileAsync(['merge-base', headOid, baseOid], {
        cwd: repoPath
    });
    return stdout.trim();
}
async function countCommits(repoPath, range) {
    const { stdout } = await gitExecFileAsync(['rev-list', '--count', range], {
        cwd: repoPath
    });
    return Number.parseInt(stdout.trim(), 10) || 0;
}
async function loadConflictingFiles(repoPath, mergeBase, headOid, baseOid) {
    let stdout = '';
    try {
        const result = await gitExecFileAsync([
            'merge-tree',
            '--write-tree',
            '--name-only',
            '-z',
            '--no-messages',
            '--merge-base',
            mergeBase,
            headOid,
            baseOid
        ], { cwd: repoPath });
        stdout = result.stdout;
    }
    catch (error) {
        const stdoutFromError = typeof error === 'object' && error && 'stdout' in error && typeof error.stdout === 'string'
            ? error.stdout
            : '';
        // Why: `git merge-tree --write-tree` exits with status 1 when it finds
        // conflicts, but still writes the conflicted file list to stdout. Treat
        // that stdout as the useful result instead of dropping the summary.
        if (!stdoutFromError) {
            throw error;
        }
        stdout = stdoutFromError;
    }
    const entries = stdout.split('\0').filter(Boolean);
    if (entries.length === 0) {
        return [];
    }
    const [, ...files] = entries;
    return files;
}
