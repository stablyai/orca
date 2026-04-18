/**
 * Centralized git/gh/command runner with transparent WSL support.
 *
 * Why: When a repo lives on a WSL filesystem (UNC path like \\wsl.localhost\Ubuntu\...),
 * native Windows binaries (git.exe, gh.exe, rg.exe) are either absent or extremely slow.
 * This module detects WSL paths and routes command execution through `wsl.exe -d <distro>`
 * with translated Linux paths, so every call site gets WSL support for free.
 */
import { type ChildProcess, type SpawnOptions } from 'child_process';
type GitExecOptions = {
    cwd: string;
    encoding?: BufferEncoding | 'buffer';
    maxBuffer?: number;
    timeout?: number;
    env?: NodeJS.ProcessEnv;
};
/**
 * Async git command execution. Drop-in replacement for
 * `execFileAsync('git', args, { cwd, encoding, ... })`.
 */
export declare function gitExecFileAsync(args: string[], options: GitExecOptions): Promise<{
    stdout: string;
    stderr: string;
}>;
/**
 * Async git command execution that returns a Buffer.
 * Used for reading binary blobs (git show).
 */
export declare function gitExecFileAsyncBuffer(args: string[], options: {
    cwd: string;
    maxBuffer?: number;
}): Promise<{
    stdout: Buffer;
}>;
/**
 * Sync git command execution. Drop-in replacement for
 * `execFileSync('git', args, { cwd, encoding, ... })`.
 *
 * Returns trimmed stdout as a string.
 */
export declare function gitExecFileSync(args: string[], options: {
    cwd: string;
    encoding?: BufferEncoding;
    stdio?: SpawnOptions['stdio'];
}): string;
/**
 * Spawn a git child process. Drop-in replacement for
 * `spawn('git', args, { cwd, stdio, ... })`.
 */
export declare function gitSpawn(args: string[], options: SpawnOptions & {
    cwd: string;
}): ChildProcess;
/**
 * Async gh CLI execution. Drop-in replacement for
 * `execFileAsync('gh', args, { cwd, encoding, ... })`.
 */
export declare function ghExecFileAsync(args: string[], options: GitExecOptions): Promise<{
    stdout: string;
    stderr: string;
}>;
/**
 * Spawn any command with WSL awareness.
 * Used for non-git binaries like `rg` that also need WSL routing.
 */
export declare function wslAwareSpawn(command: string, args: string[], options: SpawnOptions & {
    cwd?: string;
}): ChildProcess;
/**
 * Translate absolute Linux paths in git output back to Windows UNC paths.
 *
 * Why: when git runs inside WSL, paths in output (e.g. `git worktree list`)
 * are Linux-native (/home/user/repo). The rest of Orca needs Windows UNC
 * paths (\\wsl.localhost\Ubuntu\home\user\repo) to read files via Node fs.
 */
export declare function translateWslOutputPaths(output: string, originalCwd: string): string;
/**
 * Get the WSL info for a path, if applicable. Convenience re-export so
 * consumers don't need to import from wsl.ts directly.
 */
export { parseWslPath, toLinuxPath, toWindowsWslPath, isWslPath } from '../wsl';
