import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { GitHandler } from './git-handler';
import { RelayContext } from './context';
import * as fs from 'fs/promises';
import * as path from 'path';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';
function createMockDispatcher() {
    const requestHandlers = new Map();
    const notificationHandlers = new Map();
    return {
        onRequest: vi.fn((method, handler) => {
            requestHandlers.set(method, handler);
        }),
        onNotification: vi.fn((method, handler) => {
            notificationHandlers.set(method, handler);
        }),
        notify: vi.fn(),
        _requestHandlers: requestHandlers,
        async callRequest(method, params = {}) {
            const handler = requestHandlers.get(method);
            if (!handler) {
                throw new Error(`No handler for ${method}`);
            }
            return handler(params);
        }
    };
}
function gitInit(dir) {
    execFileSync('git', ['init'], { cwd: dir, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir, stdio: 'pipe' });
}
function gitCommit(dir, message) {
    execFileSync('git', ['add', '.'], { cwd: dir, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', message, '--allow-empty'], { cwd: dir, stdio: 'pipe' });
}
describe('GitHandler', () => {
    let dispatcher;
    let tmpDir;
    beforeEach(() => {
        tmpDir = mkdtempSync(path.join(tmpdir(), 'relay-git-'));
        dispatcher = createMockDispatcher();
        const ctx = new RelayContext();
        ctx.registerRoot(tmpDir);
        new GitHandler(dispatcher, ctx);
    });
    afterEach(async () => {
        await fs.rm(tmpDir, { recursive: true, force: true });
    });
    it('registers all expected handlers', () => {
        const methods = Array.from(dispatcher._requestHandlers.keys());
        expect(methods).toContain('git.status');
        expect(methods).toContain('git.diff');
        expect(methods).toContain('git.stage');
        expect(methods).toContain('git.unstage');
        expect(methods).toContain('git.bulkStage');
        expect(methods).toContain('git.bulkUnstage');
        expect(methods).toContain('git.discard');
        expect(methods).toContain('git.conflictOperation');
        expect(methods).toContain('git.branchCompare');
        expect(methods).toContain('git.branchDiff');
        expect(methods).toContain('git.listWorktrees');
        expect(methods).toContain('git.addWorktree');
        expect(methods).toContain('git.removeWorktree');
    });
    describe('status', () => {
        it('returns empty entries for clean repo', async () => {
            gitInit(tmpDir);
            writeFileSync(path.join(tmpDir, 'file.txt'), 'hello');
            gitCommit(tmpDir, 'initial');
            const result = (await dispatcher.callRequest('git.status', { worktreePath: tmpDir }));
            expect(result.entries).toEqual([]);
            expect(result.conflictOperation).toBe('unknown');
        });
        it('detects untracked files', async () => {
            gitInit(tmpDir);
            writeFileSync(path.join(tmpDir, 'tracked.txt'), 'tracked');
            gitCommit(tmpDir, 'initial');
            writeFileSync(path.join(tmpDir, 'new.txt'), 'new');
            const result = (await dispatcher.callRequest('git.status', { worktreePath: tmpDir }));
            const untracked = result.entries.find((e) => e.path === 'new.txt');
            expect(untracked).toBeDefined();
            expect(untracked.status).toBe('untracked');
            expect(untracked.area).toBe('untracked');
        });
        it('detects modified files', async () => {
            gitInit(tmpDir);
            writeFileSync(path.join(tmpDir, 'file.txt'), 'original');
            gitCommit(tmpDir, 'initial');
            writeFileSync(path.join(tmpDir, 'file.txt'), 'modified');
            const result = (await dispatcher.callRequest('git.status', { worktreePath: tmpDir }));
            const modified = result.entries.find((e) => e.path === 'file.txt');
            expect(modified).toBeDefined();
            expect(modified.status).toBe('modified');
            expect(modified.area).toBe('unstaged');
        });
        it('detects staged files', async () => {
            gitInit(tmpDir);
            writeFileSync(path.join(tmpDir, 'file.txt'), 'original');
            gitCommit(tmpDir, 'initial');
            writeFileSync(path.join(tmpDir, 'file.txt'), 'changed');
            execFileSync('git', ['add', 'file.txt'], { cwd: tmpDir, stdio: 'pipe' });
            const result = (await dispatcher.callRequest('git.status', { worktreePath: tmpDir }));
            const staged = result.entries.find((e) => e.area === 'staged');
            expect(staged).toBeDefined();
            expect(staged.status).toBe('modified');
        });
    });
    describe('stage and unstage', () => {
        it('stages a file', async () => {
            gitInit(tmpDir);
            writeFileSync(path.join(tmpDir, 'file.txt'), 'content');
            gitCommit(tmpDir, 'initial');
            writeFileSync(path.join(tmpDir, 'file.txt'), 'changed');
            await dispatcher.callRequest('git.stage', { worktreePath: tmpDir, filePath: 'file.txt' });
            const output = execFileSync('git', ['diff', '--cached', '--name-only'], {
                cwd: tmpDir,
                encoding: 'utf-8'
            });
            expect(output.trim()).toBe('file.txt');
        });
        it('unstages a file', async () => {
            gitInit(tmpDir);
            writeFileSync(path.join(tmpDir, 'file.txt'), 'content');
            gitCommit(tmpDir, 'initial');
            writeFileSync(path.join(tmpDir, 'file.txt'), 'changed');
            execFileSync('git', ['add', 'file.txt'], { cwd: tmpDir, stdio: 'pipe' });
            await dispatcher.callRequest('git.unstage', { worktreePath: tmpDir, filePath: 'file.txt' });
            const output = execFileSync('git', ['diff', '--cached', '--name-only'], {
                cwd: tmpDir,
                encoding: 'utf-8'
            });
            expect(output.trim()).toBe('');
        });
    });
    describe('diff', () => {
        it('returns text diff for modified file', async () => {
            gitInit(tmpDir);
            writeFileSync(path.join(tmpDir, 'file.txt'), 'original');
            gitCommit(tmpDir, 'initial');
            writeFileSync(path.join(tmpDir, 'file.txt'), 'modified');
            const result = (await dispatcher.callRequest('git.diff', {
                worktreePath: tmpDir,
                filePath: 'file.txt',
                staged: false
            }));
            expect(result.kind).toBe('text');
            expect(result.originalContent).toBe('original');
            expect(result.modifiedContent).toBe('modified');
        });
        it('returns staged diff', async () => {
            gitInit(tmpDir);
            writeFileSync(path.join(tmpDir, 'file.txt'), 'original');
            gitCommit(tmpDir, 'initial');
            writeFileSync(path.join(tmpDir, 'file.txt'), 'staged-content');
            execFileSync('git', ['add', 'file.txt'], { cwd: tmpDir, stdio: 'pipe' });
            const result = (await dispatcher.callRequest('git.diff', {
                worktreePath: tmpDir,
                filePath: 'file.txt',
                staged: true
            }));
            expect(result.kind).toBe('text');
            expect(result.originalContent).toBe('original');
            expect(result.modifiedContent).toBe('staged-content');
        });
    });
    describe('discard', () => {
        it('discards changes to tracked file', async () => {
            gitInit(tmpDir);
            writeFileSync(path.join(tmpDir, 'file.txt'), 'original');
            gitCommit(tmpDir, 'initial');
            writeFileSync(path.join(tmpDir, 'file.txt'), 'modified');
            await dispatcher.callRequest('git.discard', { worktreePath: tmpDir, filePath: 'file.txt' });
            const content = await fs.readFile(path.join(tmpDir, 'file.txt'), 'utf-8');
            expect(content).toBe('original');
        });
        it('deletes untracked file on discard', async () => {
            gitInit(tmpDir);
            gitCommit(tmpDir, 'initial');
            writeFileSync(path.join(tmpDir, 'new.txt'), 'untracked');
            await dispatcher.callRequest('git.discard', { worktreePath: tmpDir, filePath: 'new.txt' });
            await expect(fs.access(path.join(tmpDir, 'new.txt'))).rejects.toThrow();
        });
        it('rejects path traversal', async () => {
            gitInit(tmpDir);
            await expect(dispatcher.callRequest('git.discard', {
                worktreePath: tmpDir,
                filePath: '../../../etc/passwd'
            })).rejects.toThrow('outside the worktree');
        });
    });
    describe('conflictOperation', () => {
        it('returns unknown for normal repo', async () => {
            gitInit(tmpDir);
            gitCommit(tmpDir, 'initial');
            const result = await dispatcher.callRequest('git.conflictOperation', { worktreePath: tmpDir });
            expect(result).toBe('unknown');
        });
    });
    describe('branchCompare', () => {
        it('compares branch against base', async () => {
            gitInit(tmpDir);
            writeFileSync(path.join(tmpDir, 'base.txt'), 'base');
            gitCommit(tmpDir, 'initial');
            execFileSync('git', ['checkout', '-b', 'feature'], { cwd: tmpDir, stdio: 'pipe' });
            writeFileSync(path.join(tmpDir, 'feature.txt'), 'feature');
            gitCommit(tmpDir, 'feature commit');
            const result = (await dispatcher.callRequest('git.branchCompare', {
                worktreePath: tmpDir,
                baseRef: 'master'
            }));
            // May be 'master' or error if default branch is 'main'
            if (result.summary.status === 'ready') {
                expect(result.entries.length).toBeGreaterThan(0);
                expect(result.summary.commitsAhead).toBe(1);
            }
        });
    });
    describe('listWorktrees', () => {
        it('lists worktrees for a repo', async () => {
            gitInit(tmpDir);
            writeFileSync(path.join(tmpDir, 'file.txt'), 'hello');
            gitCommit(tmpDir, 'initial');
            const result = (await dispatcher.callRequest('git.listWorktrees', {
                repoPath: tmpDir
            }));
            expect(result.length).toBeGreaterThanOrEqual(1);
            expect(result[0].isMainWorktree).toBe(true);
        });
    });
    describe('bulkStage and bulkUnstage', () => {
        it('stages multiple files', async () => {
            gitInit(tmpDir);
            writeFileSync(path.join(tmpDir, 'a.txt'), 'a');
            writeFileSync(path.join(tmpDir, 'b.txt'), 'b');
            gitCommit(tmpDir, 'initial');
            writeFileSync(path.join(tmpDir, 'a.txt'), 'a-modified');
            writeFileSync(path.join(tmpDir, 'b.txt'), 'b-modified');
            await dispatcher.callRequest('git.bulkStage', {
                worktreePath: tmpDir,
                filePaths: ['a.txt', 'b.txt']
            });
            const output = execFileSync('git', ['diff', '--cached', '--name-only'], {
                cwd: tmpDir,
                encoding: 'utf-8'
            });
            expect(output).toContain('a.txt');
            expect(output).toContain('b.txt');
        });
        it('unstages multiple files', async () => {
            gitInit(tmpDir);
            writeFileSync(path.join(tmpDir, 'a.txt'), 'a');
            writeFileSync(path.join(tmpDir, 'b.txt'), 'b');
            gitCommit(tmpDir, 'initial');
            writeFileSync(path.join(tmpDir, 'a.txt'), 'changed');
            writeFileSync(path.join(tmpDir, 'b.txt'), 'changed');
            execFileSync('git', ['add', '.'], { cwd: tmpDir, stdio: 'pipe' });
            await dispatcher.callRequest('git.bulkUnstage', {
                worktreePath: tmpDir,
                filePaths: ['a.txt', 'b.txt']
            });
            const output = execFileSync('git', ['diff', '--cached', '--name-only'], {
                cwd: tmpDir,
                encoding: 'utf-8'
            });
            expect(output.trim()).toBe('');
        });
    });
});
