import { basename } from 'path'
import { existsSync, accessSync, statSync, chmodSync, constants as fsConstants } from 'fs'
import type * as pty from 'node-pty'

let didEnsureSpawnHelperExecutable = false

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
    const unixTerminalPath = require.resolve('node-pty/lib/unixTerminal.js')
    const packageRoot =
      basename(unixTerminalPath) === 'unixTerminal.js'
        ? unixTerminalPath.replace(/[/\\]lib[/\\]unixTerminal\.js$/, '')
        : unixTerminalPath
    const candidates = [
      `${packageRoot}/build/Release/spawn-helper`,
      `${packageRoot}/build/Debug/spawn-helper`,
      `${packageRoot}/prebuilds/${process.platform}-${process.arch}/spawn-helper`
    ].map((candidate) =>
      candidate
        .replace('app.asar/', 'app.asar.unpacked/')
        .replace('node_modules.asar/', 'node_modules.asar.unpacked/')
    )

    for (const candidate of candidates) {
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

/**
 * Validate that a working directory exists and is a directory.
 * Throws a descriptive Error if not.
 */
export function validateWorkingDirectory(cwd: string): void {
  if (!existsSync(cwd)) {
    throw new Error(
      `Working directory "${cwd}" does not exist. ` +
        `It may have been deleted or is on an unmounted volume.`
    )
  }
  if (!statSync(cwd).isDirectory()) {
    throw new Error(`Working directory "${cwd}" is not a directory.`)
  }
}

export type ShellSpawnParams = {
  shellPath: string
  shellArgs: string[]
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
}

export type ShellSpawnResult = {
  process: pty.IPty
  shellPath: string
}

/**
 * Attempt to spawn a PTY shell. If the primary shell fails on Unix,
 * try common fallback shells before giving up.
 */
export function spawnShellWithFallback(params: ShellSpawnParams): ShellSpawnResult {
  const {
    shellPath,
    shellArgs,
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
        process: ptySpawn(shellPath, shellArgs, { name: 'xterm-256color', cols, rows, cwd, env }),
        shellPath
      }
    } catch (err) {
      primaryError = err instanceof Error ? err.message : String(err)
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
          name: 'xterm-256color',
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
