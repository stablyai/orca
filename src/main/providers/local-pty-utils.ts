import { basename, join } from 'node:path'
import { existsSync, accessSync, statSync, chmodSync, constants as fsConstants } from 'node:fs'
import type * as pty from 'node-pty'
import { isWslUncPath } from '../../shared/wsl-paths'
import { wslUncDirectoryExists } from '../wsl'

let didEnsureSpawnHelperExecutable = false

function toUnpackedAsarPath(candidate: string): string {
  return candidate
    .replace(/app\.asar([/\\])/, 'app.asar.unpacked$1')
    .replace(/node_modules\.asar([/\\])/, 'node_modules.asar.unpacked$1')
}

export function getNodePtySpawnHelperCandidates(): string[] {
  const unixTerminalPath = require.resolve('node-pty/lib/unixTerminal.js')
  const packageRoot =
    basename(unixTerminalPath) === 'unixTerminal.js'
      ? unixTerminalPath.replace(/[/\\]lib[/\\]unixTerminal\.js$/, '')
      : unixTerminalPath

  return [
    join(packageRoot, 'build', 'Release', 'spawn-helper'),
    join(packageRoot, 'build', 'Debug', 'spawn-helper'),
    join(packageRoot, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper')
  ].map(toUnpackedAsarPath)
}

/**
 * Validate that a shell binary exists and is executable.
 * Returns an error message string if invalid, null if valid.
 */
export function getShellValidationError(shellPath: string): string | null {
  if (!existsSync(shellPath)) {
    return (
      `Shell "${shellPath}" does not exist. ` +
      `Set a valid SHELL environment variable or install zsh/bash.`
    )
  }
  try {
    accessSync(shellPath, fsConstants.X_OK)
  } catch {
    return `Shell "${shellPath}" is not executable. Check file permissions.`
  }
  return null
}

/**
 * Ensure the node-pty spawn-helper binary has the executable bit set.
 *
 * Why: when Electron packages the app via asar, the native spawn-helper
 * binary may lose its +x permission. This function detects and repairs
 * that so pty.spawn() does not fail with EACCES on first launch.
 */
export function ensureNodePtySpawnHelperExecutable(): void {
  if (didEnsureSpawnHelperExecutable || process.platform === 'win32') {
    return
  }
  didEnsureSpawnHelperExecutable = true

  try {
    for (const candidate of getNodePtySpawnHelperCandidates()) {
      if (!existsSync(candidate)) {
        continue
      }
      const mode = statSync(candidate).mode
      if ((mode & 0o111) !== 0) {
        return
      }
      chmodSync(candidate, mode | 0o755)
      return
    }
  } catch (error) {
    console.warn(
      `[pty] Failed to ensure node-pty spawn-helper is executable: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

function throwMissingWorkingDirectory(cwd: string): never {
  throw new Error(
    `Working directory "${cwd}" does not exist. ` +
      `It may have been deleted or is on an unmounted volume.`
  )
}

/**
 * Validate that a working directory exists and is a directory.
 * Throws a descriptive Error if not.
 */
export function validateWorkingDirectory(cwd: string): void {
  // Why: Win32 fs.statSync against the WSL 9P share (\\wsl.localhost\...) can
  // falsely report ENOENT for directories that exist on the Linux side. Ask the
  // distro itself; only fall back to the fs check when wsl.exe is inconclusive.
  if (isWslUncPath(cwd)) {
    const existsInDistro = wslUncDirectoryExists(cwd)
    if (existsInDistro === false) {
      throwMissingWorkingDirectory(cwd)
    }
    if (existsInDistro === true) {
      return
    }
  }

  if (!existsSync(cwd)) {
    throwMissingWorkingDirectory(cwd)
  }
  if (!statSync(cwd).isDirectory()) {
    throw new Error(`Working directory "${cwd}" is not a directory.`)
  }
}

/** A pre-resolved Windows shell attempt: an absolute executable plus the launch
 *  args + cwd computed for it. Used to walk the PowerShell -> Windows PowerShell
 *  -> cmd.exe fallback chain when ConPTY rejects the primary shell. */
export type WindowsShellSpawnAttempt = {
  shellPath: string
  shellArgs: string[]
  effectiveCwd: string
  validationCwd: string
  startupCommandDeliveredInShellArgs: boolean
}

export type ShellSpawnParams = {
  shellPath: string
  shellArgs: string[]
  termName?: string
  cols: number
  rows: number
  cwd: string
  env: Record<string, string>
  ptySpawn: typeof pty.spawn
  getShellReadyConfig?: (
    shell: string
  ) => { args: string[] | null; env: Record<string, string> } | null
  /** Called before each fallback shell spawn so callers can update env vars
   *  (e.g. HISTFILE) that depend on which shell is about to run. */
  onBeforeFallbackSpawn?: (env: Record<string, string>, fallbackShell: string) => void
  /** Windows-only ordered fallback chain (PowerShell -> Windows PowerShell ->
   *  cmd.exe). When the first attempt (which must match shellPath/shellArgs)
   *  fails to spawn, the next real absolute executable is tried with its own
   *  recomputed args/cwd. */
  windowsFallbackAttempts?: WindowsShellSpawnAttempt[]
}

export type ShellSpawnResult = {
  process: pty.IPty
  shellPath: string
  /** True when the winning shell's startup command was already embedded in its
   *  argv, so callers must not re-deliver it through stdin. Only set when a
   *  Windows fallback attempt other than the primary was used. */
  startupCommandDeliveredInShellArgs?: boolean
}

/**
 * Walk the Windows PowerShell -> Windows PowerShell -> cmd.exe fallback chain.
 *
 * Why: ConPTY's CreateProcessW rejects a Store App Execution Alias stub with
 * ERROR_ACCESS_DENIED (error code 5). The chain entries are real absolute
 * executables with per-shell args, so when the primary fails we retry with the
 * next safe shell instead of leaving the user with no terminal.
 */
function spawnWindowsFallbackChain(
  params: ShellSpawnParams,
  primaryError: string
): ShellSpawnResult | null {
  const { termName = 'xterm-256color', cols, rows, env, ptySpawn } = params
  const attempts = params.windowsFallbackAttempts ?? []
  // Skip the first entry: it is the primary that already failed above.
  for (const attempt of attempts.slice(1)) {
    try {
      const proc = ptySpawn(attempt.shellPath, attempt.shellArgs, {
        name: termName,
        cols,
        rows,
        cwd: attempt.effectiveCwd,
        env
      })
      console.warn(
        `[pty] Primary shell "${params.shellPath}" failed (${primaryError}), fell back to "${attempt.shellPath}"`
      )
      return {
        process: proc,
        shellPath: attempt.shellPath,
        startupCommandDeliveredInShellArgs: attempt.startupCommandDeliveredInShellArgs
      }
    } catch {
      // This fallback shell also failed -- try the next link in the chain.
    }
  }
  return null
}

/**
 * Attempt to spawn a PTY shell. If the primary shell fails, try fallback shells
 * (Unix: zsh/bash/sh; Windows: the PowerShell -> cmd.exe chain) before giving up.
 */
export function spawnShellWithFallback(params: ShellSpawnParams): ShellSpawnResult {
  const {
    shellPath,
    shellArgs,
    termName = 'xterm-256color',
    cols,
    rows,
    cwd,
    env,
    ptySpawn,
    getShellReadyConfig,
    onBeforeFallbackSpawn
  } = params
  let primaryError: string | null = null

  if (process.platform !== 'win32') {
    primaryError = getShellValidationError(shellPath)
  }

  if (!primaryError) {
    try {
      return {
        process: ptySpawn(shellPath, shellArgs, { name: termName, cols, rows, cwd, env }),
        shellPath
      }
    } catch (err) {
      primaryError = err instanceof Error ? err.message : String(err)
    }
  }

  if (process.platform === 'win32') {
    const fallback = spawnWindowsFallbackChain(params, primaryError ?? 'unknown error')
    if (fallback) {
      return fallback
    }
  }

  // Try fallback shells on Unix
  if (process.platform !== 'win32') {
    const fallbackShells = ['/bin/zsh', '/bin/bash', '/bin/sh'].filter((s) => s !== shellPath)
    for (const fallback of fallbackShells) {
      if (getShellValidationError(fallback)) {
        continue
      }
      try {
        const fallbackReady = getShellReadyConfig?.(fallback)
        env.SHELL = fallback
        onBeforeFallbackSpawn?.(env, fallback)
        Object.assign(env, fallbackReady?.env ?? {})
        const proc = ptySpawn(fallback, fallbackReady?.args ?? ['-l'], {
          name: termName,
          cols,
          rows,
          cwd,
          env
        })
        console.warn(
          `[pty] Primary shell "${shellPath}" failed (${primaryError ?? 'unknown error'}), fell back to "${fallback}"`
        )
        return { process: proc, shellPath: fallback }
      } catch {
        // Fallback also failed -- try next.
      }
    }
  }

  const diag = [
    `shell: ${shellPath}`,
    `cwd: ${cwd}`,
    `arch: ${process.arch}`,
    `platform: ${process.platform} ${process.getSystemVersion?.() ?? ''}`
  ].join(', ')
  throw new Error(
    `Failed to spawn shell "${shellPath}": ${primaryError ?? 'unknown error'} (${diag}). ` +
      `If this persists, please file an issue.`
  )
}
