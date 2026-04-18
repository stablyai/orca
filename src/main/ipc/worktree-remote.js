// Why: extracted from worktrees.ts to keep the main IPC module under the
// max-lines threshold. Worktree creation helpers (local and remote) live
// here so the IPC dispatch file stays focused on handler wiring.
import { join } from 'path';
import { existsSync } from 'fs';
import { getPRForBranch } from '../github/client';
import { listWorktrees, addWorktree } from '../git/worktree';
import { getGitUsername, getDefaultBaseRef, getBranchConflictKind } from '../git/repo';
import { gitExecFileSync } from '../git/runner';
import { isWslPath, parseWslPath, getWslHome } from '../wsl';
import { createSetupRunnerScript, getEffectiveHooks, shouldRunSetupForCreate } from '../hooks';
import { getSshGitProvider } from '../providers/ssh-git-dispatch';
import { sanitizeWorktreeName, computeBranchName, computeWorktreePath, ensurePathWithinWorkspace, shouldSetDisplayName, mergeWorktree, areWorktreePathsEqual } from './worktree-logic';
import { rebuildAuthorizedRootsCache } from './filesystem-auth';
export function notifyWorktreesChanged(mainWindow, repoId) {
    if (!mainWindow.isDestroyed()) {
        mainWindow.webContents.send('worktrees:changed', { repoId });
    }
}
export async function createRemoteWorktree(args, repo, store, mainWindow) {
    const provider = getSshGitProvider(repo.connectionId);
    if (!provider) {
        throw new Error(`No git provider for connection "${repo.connectionId}"`);
    }
    const settings = store.getSettings();
    const requestedName = args.name;
    const sanitizedName = sanitizeWorktreeName(args.name);
    // Get git username from remote
    let username = '';
    try {
        const { stdout } = await provider.exec(['config', 'user.name'], repo.path);
        username = stdout.trim();
    }
    catch {
        /* no username configured */
    }
    const branchName = computeBranchName(sanitizedName, settings, username);
    // Check branch conflict on remote
    try {
        const { stdout } = await provider.exec(['branch', '--list', '--all', branchName], repo.path);
        if (stdout.trim()) {
            throw new Error(`Branch "${branchName}" already exists. Pick a different worktree name.`);
        }
    }
    catch (e) {
        if (e instanceof Error && e.message.includes('already exists')) {
            throw e;
        }
    }
    // Compute worktree path relative to the repo's parent on the remote
    const remotePath = `${repo.path}/../${sanitizedName}`;
    // Determine base branch
    let baseBranch = args.baseBranch || repo.worktreeBaseRef;
    if (!baseBranch) {
        try {
            const { stdout } = await provider.exec(['symbolic-ref', 'refs/remotes/origin/HEAD', '--short'], repo.path);
            baseBranch = stdout.trim();
        }
        catch {
            baseBranch = 'origin/main';
        }
    }
    // Fetch latest
    const remote = baseBranch.includes('/') ? baseBranch.split('/')[0] : 'origin';
    try {
        await provider.exec(['fetch', remote], repo.path);
    }
    catch {
        /* best-effort */
    }
    // Create worktree via relay
    await provider.addWorktree(repo.path, branchName, remotePath, {
        base: baseBranch,
        track: baseBranch.includes('/')
    });
    // Re-list to get the created worktree info
    const gitWorktrees = await provider.listWorktrees(repo.path);
    const created = gitWorktrees.find((gw) => gw.branch?.endsWith(branchName) || gw.path.endsWith(sanitizedName));
    if (!created) {
        throw new Error('Worktree created but not found in listing');
    }
    const worktreeId = `${repo.id}::${created.path}`;
    const metaUpdates = {
        lastActivityAt: Date.now(),
        ...(shouldSetDisplayName(requestedName, branchName, sanitizedName)
            ? { displayName: requestedName }
            : {})
    };
    const meta = store.setWorktreeMeta(worktreeId, metaUpdates);
    const worktree = mergeWorktree(repo.id, created, meta);
    notifyWorktreesChanged(mainWindow, repo.id);
    return { worktree };
}
export async function createLocalWorktree(args, repo, store, mainWindow) {
    const settings = store.getSettings();
    const username = getGitUsername(repo.path);
    const requestedName = args.name;
    const sanitizedName = sanitizeWorktreeName(args.name);
    // Why: WSL worktrees live under ~/orca/workspaces inside the WSL
    // filesystem. Validate against that root, not the Windows workspace dir.
    // If WSL home lookup fails, keep using the configured workspace root so
    // the path traversal guard still runs on the fallback path.
    const wslInfo = isWslPath(repo.path) ? parseWslPath(repo.path) : null;
    const wslHome = wslInfo ? getWslHome(wslInfo.distro) : null;
    const workspaceRoot = wslHome ? join(wslHome, 'orca', 'workspaces') : settings.workspaceDir;
    let effectiveRequestedName = requestedName;
    let effectiveSanitizedName = sanitizedName;
    let branchName = '';
    let worktreePath = '';
    // Why: silently resolve branch/path/PR name collisions by appending -2/-3/etc.
    // instead of failing and forcing the user back to the name picker. This is
    // especially important for the new-workspace flow where the user may not have
    // direct control over the branch name. Bounded by MAX_SUFFIX_ATTEMPTS so a
    // misconfigured environment (e.g. a mock or stub that always reports a
    // conflict) cannot spin this loop indefinitely.
    const MAX_SUFFIX_ATTEMPTS = 100;
    let resolved = false;
    let lastBranchConflictKind = null;
    let lastExistingPR = null;
    for (let suffix = 1; suffix <= MAX_SUFFIX_ATTEMPTS; suffix += 1) {
        effectiveSanitizedName = suffix === 1 ? sanitizedName : `${sanitizedName}-${suffix}`;
        effectiveRequestedName =
            suffix === 1
                ? requestedName
                : requestedName.trim()
                    ? `${requestedName}-${suffix}`
                    : effectiveSanitizedName;
        branchName = computeBranchName(effectiveSanitizedName, settings, username);
        lastBranchConflictKind = await getBranchConflictKind(repo.path, branchName);
        if (lastBranchConflictKind) {
            continue;
        }
        // Why: the UI resolves PR status by branch name alone. Reusing a historical
        // PR head name would make a fresh worktree inherit that old merged/closed PR
        // immediately, so auto-suffix until we land on a fresh branch identity.
        lastExistingPR = null;
        try {
            lastExistingPR = await getPRForBranch(repo.path, branchName);
        }
        catch {
            // GitHub API may be unreachable, rate-limited, or token missing
        }
        if (lastExistingPR) {
            continue;
        }
        worktreePath = ensurePathWithinWorkspace(computeWorktreePath(effectiveSanitizedName, repo.path, settings), workspaceRoot);
        if (existsSync(worktreePath)) {
            continue;
        }
        resolved = true;
        break;
    }
    if (!resolved) {
        // Why: if every suffix in range collides, fall back to the original
        // "reject with a specific reason" behavior so the user sees why creation
        // failed instead of a generic error or (worse) an infinite spinner.
        if (lastExistingPR) {
            throw new Error(`Branch "${branchName}" already has PR #${lastExistingPR.number}. Pick a different worktree name.`);
        }
        if (lastBranchConflictKind) {
            throw new Error(`Branch "${branchName}" already exists ${lastBranchConflictKind === 'local' ? 'locally' : 'on a remote'}. Pick a different worktree name.`);
        }
        throw new Error(`Could not find an available worktree name for "${sanitizedName}". Pick a different worktree name.`);
    }
    // Determine base branch
    const baseBranch = args.baseBranch || repo.worktreeBaseRef || getDefaultBaseRef(repo.path);
    const setupScript = getEffectiveHooks(repo)?.scripts.setup;
    // Why: `ask` is a pre-create choice gate, not a post-create side effect.
    // Resolve it before mutating git state so missing UI input cannot strand
    // a real worktree on disk while the renderer reports "create failed".
    const shouldLaunchSetup = setupScript ? shouldRunSetupForCreate(repo, args.setupDecision) : false;
    // Fetch latest from remote so the worktree starts with up-to-date content
    const remote = baseBranch.includes('/') ? baseBranch.split('/')[0] : 'origin';
    try {
        gitExecFileSync(['fetch', remote], { cwd: repo.path });
    }
    catch {
        // Fetch is best-effort — don't block worktree creation if offline
    }
    await addWorktree(repo.path, worktreePath, branchName, baseBranch, settings.refreshLocalBaseRefOnWorktreeCreate);
    // Re-list to get the freshly created worktree info
    const gitWorktrees = await listWorktrees(repo.path);
    const created = gitWorktrees.find((gw) => areWorktreePathsEqual(gw.path, worktreePath));
    if (!created) {
        throw new Error('Worktree created but not found in listing');
    }
    const worktreeId = `${repo.id}::${created.path}`;
    const metaUpdates = {
        // Stamp activity so the worktree sorts into its final position
        // immediately — prevents scroll-to-reveal racing with a later
        // bumpWorktreeActivity that would re-sort the list.
        lastActivityAt: Date.now(),
        ...(shouldSetDisplayName(effectiveRequestedName, branchName, effectiveSanitizedName)
            ? { displayName: effectiveRequestedName }
            : {})
    };
    const meta = store.setWorktreeMeta(worktreeId, metaUpdates);
    const worktree = mergeWorktree(repo.id, created, meta);
    await rebuildAuthorizedRootsCache(store);
    let setup;
    if (setupScript && shouldLaunchSetup) {
        try {
            // Why: setup now runs in a visible terminal owned by the renderer so users
            // can inspect failures, answer prompts, and rerun it. The main process only
            // resolves policy and writes the runner script; it must not execute setup
            // itself anymore or we would reintroduce the hidden background-hook behavior.
            //
            // Why: the git worktree already exists at this point. If runner generation
            // fails, surfacing the error as a hard create failure would lie to the UI
            // about the underlying git state and strand a real worktree on disk.
            // Degrade to "created without setup launch" instead.
            setup = createSetupRunnerScript(repo, worktreePath, setupScript);
        }
        catch (error) {
            console.error(`[hooks] Failed to prepare setup runner for ${worktreePath}:`, error);
        }
    }
    notifyWorktreesChanged(mainWindow, repo.id);
    return {
        worktree,
        ...(setup ? { setup } : {})
    };
}
