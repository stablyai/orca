import { execFile } from 'child_process';
import { promisify } from 'util';
import { existsSync } from 'fs';
import { readFile, rm } from 'fs/promises';
import * as path from 'path';
import { parseStatusOutput, parseUnmergedEntry, parseBranchDiff, parseWorktreeList } from './git-handler-utils';
import { computeDiff, branchCompare as branchCompareOp, branchDiffEntries, validateGitExecArgs } from './git-handler-ops';
const execFileAsync = promisify(execFile);
const MAX_GIT_BUFFER = 10 * 1024 * 1024;
const BULK_CHUNK_SIZE = 100;
export class GitHandler {
    dispatcher;
    context;
    constructor(dispatcher, context) {
        this.dispatcher = dispatcher;
        this.context = context;
        this.registerHandlers();
    }
    registerHandlers() {
        this.dispatcher.onRequest('git.status', (p) => this.getStatus(p));
        this.dispatcher.onRequest('git.diff', (p) => this.getDiff(p));
        this.dispatcher.onRequest('git.stage', (p) => this.stage(p));
        this.dispatcher.onRequest('git.unstage', (p) => this.unstage(p));
        this.dispatcher.onRequest('git.bulkStage', (p) => this.bulkStage(p));
        this.dispatcher.onRequest('git.bulkUnstage', (p) => this.bulkUnstage(p));
        this.dispatcher.onRequest('git.discard', (p) => this.discard(p));
        this.dispatcher.onRequest('git.conflictOperation', (p) => this.conflictOperation(p));
        this.dispatcher.onRequest('git.branchCompare', (p) => this.branchCompare(p));
        this.dispatcher.onRequest('git.branchDiff', (p) => this.branchDiff(p));
        this.dispatcher.onRequest('git.listWorktrees', (p) => this.listWorktrees(p));
        this.dispatcher.onRequest('git.addWorktree', (p) => this.addWorktree(p));
        this.dispatcher.onRequest('git.removeWorktree', (p) => this.removeWorktree(p));
        this.dispatcher.onRequest('git.exec', (p) => this.exec(p));
        this.dispatcher.onRequest('git.isGitRepo', (p) => this.isGitRepo(p));
    }
    async git(args, cwd, opts) {
        return execFileAsync('git', args, {
            cwd,
            encoding: 'utf-8',
            maxBuffer: opts?.maxBuffer ?? MAX_GIT_BUFFER
        });
    }
    async gitBuffer(args, cwd) {
        const { stdout } = (await execFileAsync('git', args, {
            cwd,
            encoding: 'buffer',
            maxBuffer: MAX_GIT_BUFFER
        }));
        return stdout;
    }
    async getStatus(params) {
        const worktreePath = params.worktreePath;
        this.context.validatePath(worktreePath);
        const conflictOperation = await this.detectConflictOperation(worktreePath);
        const entries = [];
        try {
            const { stdout } = await this.git(['status', '--porcelain=v2', '--untracked-files=all'], worktreePath);
            const parsed = parseStatusOutput(stdout);
            entries.push(...parsed.entries);
            for (const uLine of parsed.unmergedLines) {
                const entry = parseUnmergedEntry(worktreePath, uLine);
                if (entry) {
                    entries.push(entry);
                }
            }
        }
        catch {
            // Not a git repo or git not available
        }
        return { entries, conflictOperation };
    }
    async detectConflictOperation(worktreePath) {
        const gitDir = await this.resolveGitDir(worktreePath);
        try {
            if (existsSync(path.join(gitDir, 'MERGE_HEAD'))) {
                return 'merge';
            }
            if (existsSync(path.join(gitDir, 'rebase-merge')) ||
                existsSync(path.join(gitDir, 'rebase-apply'))) {
                return 'rebase';
            }
            if (existsSync(path.join(gitDir, 'CHERRY_PICK_HEAD'))) {
                return 'cherry-pick';
            }
        }
        catch {
            // fs error
        }
        return 'unknown';
    }
    async resolveGitDir(worktreePath) {
        const dotGitPath = path.join(worktreePath, '.git');
        try {
            const contents = await readFile(dotGitPath, 'utf-8');
            const match = contents.match(/^gitdir:\s*(.+)\s*$/m);
            if (match) {
                return path.resolve(worktreePath, match[1]);
            }
        }
        catch {
            // .git is a directory
        }
        return dotGitPath;
    }
    async getDiff(params) {
        const worktreePath = params.worktreePath;
        this.context.validatePath(worktreePath);
        const filePath = params.filePath;
        // Why: filePath is relative to worktreePath and used in readWorkingFile via
        // path.join. Without validation, ../../etc/passwd traverses outside the worktree.
        const resolved = path.resolve(worktreePath, filePath);
        const rel = path.relative(path.resolve(worktreePath), resolved);
        if (rel.startsWith('..') || path.isAbsolute(rel)) {
            throw new Error(`Path "${filePath}" resolves outside the worktree`);
        }
        const staged = params.staged;
        return computeDiff(this.gitBuffer.bind(this), worktreePath, filePath, staged);
    }
    async stage(params) {
        const worktreePath = params.worktreePath;
        this.context.validatePath(worktreePath);
        const filePath = params.filePath;
        await this.git(['add', '--', filePath], worktreePath);
    }
    async unstage(params) {
        const worktreePath = params.worktreePath;
        this.context.validatePath(worktreePath);
        const filePath = params.filePath;
        await this.git(['restore', '--staged', '--', filePath], worktreePath);
    }
    async bulkStage(params) {
        const worktreePath = params.worktreePath;
        this.context.validatePath(worktreePath);
        const filePaths = params.filePaths;
        for (let i = 0; i < filePaths.length; i += BULK_CHUNK_SIZE) {
            const chunk = filePaths.slice(i, i + BULK_CHUNK_SIZE);
            await this.git(['add', '--', ...chunk], worktreePath);
        }
    }
    async bulkUnstage(params) {
        const worktreePath = params.worktreePath;
        this.context.validatePath(worktreePath);
        const filePaths = params.filePaths;
        for (let i = 0; i < filePaths.length; i += BULK_CHUNK_SIZE) {
            const chunk = filePaths.slice(i, i + BULK_CHUNK_SIZE);
            await this.git(['restore', '--staged', '--', ...chunk], worktreePath);
        }
    }
    async discard(params) {
        const worktreePath = params.worktreePath;
        this.context.validatePath(worktreePath);
        const filePath = params.filePath;
        const resolved = path.resolve(worktreePath, filePath);
        const rel = path.relative(path.resolve(worktreePath), resolved);
        // Why: empty rel or '.' means the path IS the worktree root — rm -rf would
        // delete the entire worktree. Reject along with parent-escaping paths.
        if (!rel || rel === '.' || rel === '..' || rel.startsWith('../') || path.isAbsolute(rel)) {
            throw new Error(`Path "${filePath}" resolves outside the worktree`);
        }
        let tracked = false;
        try {
            await this.git(['ls-files', '--error-unmatch', '--', filePath], worktreePath);
            tracked = true;
        }
        catch {
            // untracked
        }
        if (tracked) {
            await this.git(['restore', '--worktree', '--source=HEAD', '--', filePath], worktreePath);
        }
        else {
            // Why: textual path checks pass for symlinks inside the worktree, but
            // rm follows symlinks — so a symlink pointing outside the workspace
            // would delete the target. validatePathResolved catches this.
            await this.context.validatePathResolved(resolved);
            await rm(resolved, { force: true, recursive: true });
        }
    }
    async conflictOperation(params) {
        const worktreePath = params.worktreePath;
        this.context.validatePath(worktreePath);
        return this.detectConflictOperation(worktreePath);
    }
    async branchCompare(params) {
        const worktreePath = params.worktreePath;
        this.context.validatePath(worktreePath);
        const baseRef = params.baseRef;
        // Why: a baseRef starting with '-' would be interpreted as a flag to
        // git rev-parse, potentially leaking environment variables or config.
        if (baseRef.startsWith('-')) {
            throw new Error('Base ref must not start with "-"');
        }
        const gitBound = this.git.bind(this);
        return branchCompareOp(gitBound, worktreePath, baseRef, async (mergeBase, headOid) => {
            const { stdout } = await gitBound(['diff', '--name-status', '-M', '-C', mergeBase, headOid], worktreePath);
            return parseBranchDiff(stdout);
        });
    }
    async branchDiff(params) {
        const worktreePath = params.worktreePath;
        this.context.validatePath(worktreePath);
        const baseRef = params.baseRef;
        if (baseRef.startsWith('-')) {
            throw new Error('Base ref must not start with "-"');
        }
        return branchDiffEntries(this.git.bind(this), this.gitBuffer.bind(this), worktreePath, baseRef, {
            includePatch: params.includePatch,
            filePath: params.filePath,
            oldPath: params.oldPath
        });
    }
    async exec(params) {
        const args = params.args;
        const cwd = params.cwd;
        this.context.validatePath(cwd);
        validateGitExecArgs(args);
        const { stdout, stderr } = await this.git(args, cwd);
        return { stdout, stderr };
    }
    // Why: isGitRepo is called during the add-repo flow before any workspace
    // roots are registered with the relay. Skipping validatePath is safe because
    // this is a read-only git rev-parse check — no files are mutated.
    async isGitRepo(params) {
        const dirPath = params.dirPath;
        try {
            const { stdout } = await this.git(['rev-parse', '--show-toplevel'], dirPath);
            return { isRepo: true, rootPath: stdout.trim() };
        }
        catch {
            return { isRepo: false, rootPath: null };
        }
    }
    async listWorktrees(params) {
        const repoPath = params.repoPath;
        this.context.validatePath(repoPath);
        try {
            const { stdout } = await this.git(['worktree', 'list', '--porcelain'], repoPath);
            return parseWorktreeList(stdout);
        }
        catch {
            return [];
        }
    }
    async addWorktree(params) {
        const repoPath = params.repoPath;
        this.context.validatePath(repoPath);
        const branchName = params.branchName;
        const targetDir = params.targetDir;
        this.context.validatePath(targetDir);
        const base = params.base;
        const track = params.track;
        // Why: a branchName starting with '-' would be interpreted as a git flag,
        // potentially changing the command's semantics (e.g. "--detach").
        if (branchName.startsWith('-') || (base && base.startsWith('-'))) {
            throw new Error('Branch name and base ref must not start with "-"');
        }
        const args = ['worktree', 'add'];
        if (track) {
            args.push('--track');
        }
        args.push('-b', branchName, targetDir);
        if (base) {
            args.push(base);
        }
        await this.git(args, repoPath);
    }
    async removeWorktree(params) {
        const worktreePath = params.worktreePath;
        this.context.validatePath(worktreePath);
        const force = params.force;
        let repoPath = worktreePath;
        try {
            const { stdout } = await this.git(['rev-parse', '--git-common-dir'], worktreePath);
            const commonDir = stdout.trim();
            if (commonDir && commonDir !== '.git') {
                repoPath = path.resolve(worktreePath, commonDir, '..');
            }
        }
        catch {
            // Fall through with worktreePath as repo
        }
        const args = ['worktree', 'remove'];
        if (force) {
            args.push('--force');
        }
        args.push(worktreePath);
        await this.git(args, repoPath);
        await this.git(['worktree', 'prune'], repoPath);
    }
}
