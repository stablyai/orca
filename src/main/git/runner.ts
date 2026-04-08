/**
 * Centralized git/gh/command runner with transparent WSL support.
 *
 * Why: When a repo lives on a WSL filesystem (UNC path like \\wsl.localhost\Ubuntu\...),
 * native Windows binaries (git.exe, gh.exe, rg.exe) are either absent or extremely slow.
 * This module detects WSL paths and routes command execution through `wsl.exe -d <distro>`
 * with translated Linux paths, so every call site gets WSL support for free.
 */
import {
  execFile,
  execFileSync,
  spawn,
  type ChildProcess,
  type SpawnOptions
} from 'child_process'
import { promisify } from 'util'
import { parseWslPath, toWindowsWslPath, type WslPathInfo } from '../wsl'

const execFileAsync = promisify(execFile)

// ─── Core resolution ────────────────────────────────────────────────

type ResolvedCommand = {
  binary: string
  args: string[]
  cwd: string | undefined
  /** Non-null when the command was routed through WSL. */
  wsl: WslPathInfo | null
}

/**
 * Translate any Windows-style paths in command arguments to Linux paths
 * when the command will execute inside WSL.
 *
 * Why: callers like worktree-create pass Windows paths (e.g. the workspace
 * directory) as git arguments. WSL git doesn't understand Windows paths,
 * so we must translate them. WSL UNC paths (\\wsl.localhost\...) are
 * converted to their native Linux form; regular Windows drive paths
 * (C:\Users\...) are converted to /mnt/c/Users/...
 */
function translateArgsForWsl(args: string[]): string[] {
  return args.map((arg) => {
    // WSL UNC path → native linux path
    const wslInfo = parseWslPath(arg)
    if (wslInfo) {
      return wslInfo.linuxPath
    }

    // Windows drive path (e.g. C:\Users\...) → /mnt/c/Users/...
    const driveMatch = arg.match(/^([A-Za-z]):[/\\](.*)$/)
    if (driveMatch) {
      const driveLetter = driveMatch[1].toLowerCase()
      const rest = driveMatch[2].replace(/\\/g, '/')
      return `/mnt/${driveLetter}/${rest}`
    }

    return arg
  })
}

/**
 * Given a command, its arguments, and a working directory, resolve whether
 * the invocation should be routed through wsl.exe.
 *
 * Why `bash -c "cd ... && ..."` instead of `--cd`: wsl.exe's --cd flag
 * does not work reliably when invoked via Node's execFile/spawn (it fails
 * with ERROR_PATH_NOT_FOUND in some configurations). Using bash -c with
 * an explicit cd is universally supported.
 */
function resolveCommand(
  command: string,
  args: string[],
  cwd: string | undefined
): ResolvedCommand {
  if (!cwd || process.platform !== 'win32') {
    return { binary: command, args, cwd, wsl: null }
  }

  const wsl = parseWslPath(cwd)
  if (!wsl) {
    return { binary: command, args, cwd, wsl: null }
  }

  const translatedArgs = translateArgsForWsl(args)
  // Why: shell-escape each argument to prevent word splitting / glob expansion
  // inside the bash -c string. Single quotes are safe for all chars except
  // single quotes themselves, which we escape as '\'' (end quote, escaped
  // literal, reopen quote).
  const escapedArgs = translatedArgs.map(
    (a) => `'${a.replace(/'/g, "'\\''")}'`
  )
  const escapedCwd = wsl.linuxPath.replace(/'/g, "'\\''")
  const shellCmd = `cd '${escapedCwd}' && ${command} ${escapedArgs.join(' ')}`

  return {
    binary: 'wsl.exe',
    args: ['-d', wsl.distro, '--', 'bash', '-c', shellCmd],
    // Why: cwd is set to undefined because wsl.exe handles directory switching
    // via the cd inside bash -c. Setting a UNC cwd on the Node process would
    // be redundant and can cause issues with some Node internals.
    cwd: undefined,
    wsl
  }
}

// ─── Git-specific runners ───────────────────────────────────────────

type GitExecOptions = {
  cwd: string
  encoding?: BufferEncoding | 'buffer'
  maxBuffer?: number
  timeout?: number
  env?: NodeJS.ProcessEnv
}

/**
 * Async git command execution. Drop-in replacement for
 * `execFileAsync('git', args, { cwd, encoding, ... })`.
 */
export async function gitExecFileAsync(
  args: string[],
  options: GitExecOptions
): Promise<{ stdout: string; stderr: string }> {
  const resolved = resolveCommand('git', args, options.cwd)
  const { stdout, stderr } = await execFileAsync(resolved.binary, resolved.args, {
    cwd: resolved.cwd,
    encoding: (options.encoding ?? 'utf-8') as BufferEncoding,
    maxBuffer: options.maxBuffer,
    timeout: options.timeout,
    env: options.env
  })
  return { stdout: stdout as string, stderr: stderr as string }
}

/**
 * Async git command execution that returns a Buffer.
 * Used for reading binary blobs (git show).
 */
export async function gitExecFileAsyncBuffer(
  args: string[],
  options: { cwd: string; maxBuffer?: number }
): Promise<{ stdout: Buffer }> {
  const resolved = resolveCommand('git', args, options.cwd)
  const { stdout } = (await execFileAsync(resolved.binary, resolved.args, {
    cwd: resolved.cwd,
    encoding: 'buffer',
    maxBuffer: options.maxBuffer
  })) as { stdout: Buffer }
  return { stdout }
}

/**
 * Sync git command execution. Drop-in replacement for
 * `execFileSync('git', args, { cwd, encoding, ... })`.
 *
 * Returns trimmed stdout as a string.
 */
export function gitExecFileSync(
  args: string[],
  options: {
    cwd: string
    encoding?: BufferEncoding
    stdio?: SpawnOptions['stdio']
  }
): string {
  const resolved = resolveCommand('git', args, options.cwd)
  return execFileSync(resolved.binary, resolved.args, {
    cwd: resolved.cwd,
    encoding: options.encoding ?? 'utf-8',
    stdio: options.stdio ?? ['pipe', 'pipe', 'pipe']
  }) as string
}

/**
 * Spawn a git child process. Drop-in replacement for
 * `spawn('git', args, { cwd, stdio, ... })`.
 */
export function gitSpawn(
  args: string[],
  options: SpawnOptions & { cwd: string }
): ChildProcess {
  const resolved = resolveCommand('git', args, options.cwd)
  return spawn(resolved.binary, resolved.args, {
    ...options,
    cwd: resolved.cwd
  })
}

// ─── gh CLI runners ─────────────────────────────────────────────────

/**
 * Async gh CLI execution. Drop-in replacement for
 * `execFileAsync('gh', args, { cwd, encoding, ... })`.
 */
export async function ghExecFileAsync(
  args: string[],
  options: GitExecOptions
): Promise<{ stdout: string; stderr: string }> {
  const resolved = resolveCommand('gh', args, options.cwd)
  const { stdout, stderr } = await execFileAsync(resolved.binary, resolved.args, {
    cwd: resolved.cwd,
    encoding: (options.encoding ?? 'utf-8') as BufferEncoding,
    maxBuffer: options.maxBuffer,
    timeout: options.timeout,
    env: options.env
  })
  return { stdout: stdout as string, stderr: stderr as string }
}

// ─── Generic command runner (for rg, etc.) ──────────────────────────

/**
 * Spawn any command with WSL awareness.
 * Used for non-git binaries like `rg` that also need WSL routing.
 */
export function wslAwareSpawn(
  command: string,
  args: string[],
  options: SpawnOptions & { cwd?: string }
): ChildProcess {
  const resolved = resolveCommand(command, args, options.cwd)
  return spawn(resolved.binary, resolved.args, {
    ...options,
    cwd: resolved.cwd
  })
}

// ─── Path translation helpers ───────────────────────────────────────

/**
 * Translate absolute Linux paths in git output back to Windows UNC paths.
 *
 * Why: when git runs inside WSL, paths in output (e.g. `git worktree list`)
 * are Linux-native (/home/user/repo). The rest of Orca needs Windows UNC
 * paths (\\wsl.localhost\Ubuntu\home\user\repo) to read files via Node fs.
 */
export function translateWslOutputPaths(
  output: string,
  originalCwd: string
): string {
  const wsl = parseWslPath(originalCwd)
  if (!wsl) {
    return output
  }

  // Replace absolute Linux paths that start with / and look like filesystem
  // paths in structured git output (e.g. "worktree /home/user/repo/feature")
  return output.replace(
    /(?<=worktree )(\/.+)$/gm,
    (_match, linuxPath: string) => toWindowsWslPath(linuxPath, wsl.distro)
  )
}

/**
 * Get the WSL info for a path, if applicable. Convenience re-export so
 * consumers don't need to import from wsl.ts directly.
 */
export { parseWslPath, toLinuxPath, toWindowsWslPath, isWslPath } from '../wsl'
