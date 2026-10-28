import { basename, isAbsolute, join } from 'node:path'
import { existsSync, accessSync, statSync, chmodSync, constants as fsConstants } from 'node:fs'
import type * as pty from 'node-pty'
import {
  nodePtyNativeBuildEntryDir,
  usesNodePtySpawnHelper
} from '../../shared/node-pty-spawn-helper'
import { TERMINAL_SPAWN_ISSUE_REQUEST } from '../../shared/terminal-spawn-error-copy'
import {
  hostReportsChildExitStatus,
  wrapShellSpawnForMacosTccAttribution
} from './macos-tcc-login-shell'
import { formatLocalPtyEnvironmentDiag } from './working-directory-validation'

export {
  formatLocalPtyEnvironmentDiag,
  validateWorkingDirectory,
  validateWorkingDirectoryAsync,
  WorkingDirectoryValidationAbortedError
} from './working-directory-validation'

let didEnsureSpawnHelperExecutable = false

const UNIX_SHELL_FALLBACKS = ['/bin/zsh', '/bin/bash', '/bin/sh'] as const

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
    join(packageRoot, nodePtyNativeBuildEntryDir(process.platform, process.arch), 'spawn-helper'),
    join(packageRoot, 'build', 'Release', 'spawn-helper'),
    join(packageRoot, 'build', 'Debug', 'spawn-helper'),
    join(packageRoot, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper')
  ].map(toUnpackedAsarPath)
}

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

/** Resolve absolute Unix paths before fork; leave bare/relative commands to execvp PATH/cwd lookup. */
export function resolveUnixShellPath(shellPath: string): string {
  if (!isAbsolute(shellPath)) {
    return shellPath
  }
  const candidates = [
    shellPath,
    ...UNIX_SHELL_FALLBACKS.filter((candidate) => candidate !== shellPath)
  ]
  const resolved = candidates.find((candidate) => getShellValidationError(candidate) === null)
  if (resolved) {
    return resolved
  }
  throw new Error(`No executable Unix shell found (tried: ${candidates.join(', ')})`)
}

/** Packaged macOS asar can lose spawn-helper +x and cause first-launch EACCES; other platforms do not use it. */
export function ensureNodePtySpawnHelperExecutable(): void {
  if (didEnsureSpawnHelperExecutable || !usesNodePtySpawnHelper(process.platform)) {
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

/** Pre-resolve each Windows fallback executable with its own argv and cwd. */
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
  /** Original env values (undefined means unset); re-deriving keys would regenerate wrappers. */
  preLaunchEnv?: Readonly<Record<string, string | undefined>>
  /** Update shell-dependent env, such as HISTFILE, before each fallback spawn. */
  onBeforeFallbackSpawn?: (env: Record<string, string>, fallbackShell: string) => void
  /** Ordered Windows fallbacks; the first entry must match the primary shell/argv. */
  windowsFallbackAttempts?: WindowsShellSpawnAttempt[]
}

export type ShellSpawnResult = {
  process: pty.IPty
  shellPath: string
  /** False when a login wrapper reports its own status instead of the shell outcome (STA-4536). */
  reportsChildExitStatus?: boolean
  /** Windows fallback embedded startup in argv; prevent duplicate stdin delivery. */
  startupCommandDeliveredInShellArgs?: boolean
}

// Bundled ConPTY matches daemon wrap markers; system ConPTY can corrupt wide TUI scrollback in local fallback mode.
function windowsConptyDllOptions(): { useConptyDll: true } | Record<string, never> {
  return process.platform === 'win32' ? { useConptyDll: true } : {}
}

// ConPTY can reject Store aliases with access-denied (5); try pre-resolved real executables instead.
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
        env,
        ...windowsConptyDllOptions()
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

export type PtyExecutableSpawnParams = Pick<
  ShellSpawnParams,
  'termName' | 'cols' | 'rows' | 'cwd' | 'env' | 'ptySpawn'
> & { file: string; args: string[] }

/** One executable with an argv array, no shell and no fallback; throws when it can't start. */
export function spawnPtyExecutable(params: PtyExecutableSpawnParams): pty.IPty {
  const { file, args, termName = 'xterm-256color', cols, rows, cwd, env, ptySpawn } = params
  return ptySpawn(file, args, {
    name: termName,
    cols,
    rows,
    cwd,
    env,
    ...windowsConptyDllOptions()
  })
}

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
      const wrapped = wrapShellSpawnForMacosTccAttribution(shellPath, shellArgs, env)
      return {
        process: spawnPtyExecutable({
          file: wrapped.file,
          args: wrapped.args,
          termName,
          cols,
          rows,
          cwd,
          env,
          ptySpawn
        }),
        shellPath,
        reportsChildExitStatus: hostReportsChildExitStatus(wrapped.file)
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

  if (process.platform !== 'win32') {
    const fallbackShells = UNIX_SHELL_FALLBACKS.filter((candidate) => candidate !== shellPath)
    // Restore the previous attempt env before each fallback so wrapper ZDOTDIR/features cannot leak to another shell.
    let preLaunchEnv = params.preLaunchEnv ?? {}
    for (const fallback of fallbackShells) {
      if (getShellValidationError(fallback)) {
        continue
      }
      try {
        const fallbackReady = getShellReadyConfig?.(fallback)
        env.SHELL = fallback
        onBeforeFallbackSpawn?.(env, fallback)
        for (const [key, value] of Object.entries(preLaunchEnv)) {
          if (value === undefined) {
            delete env[key]
          } else {
            env[key] = value
          }
        }
        const fallbackEnv = fallbackReady?.env ?? {}
        preLaunchEnv = Object.fromEntries(Object.keys(fallbackEnv).map((key) => [key, env[key]]))
        Object.assign(env, fallbackEnv)
        const wrapped = wrapShellSpawnForMacosTccAttribution(
          fallback,
          fallbackReady?.args ?? ['-l'],
          env
        )
        const proc = ptySpawn(wrapped.file, wrapped.args, {
          name: termName,
          cols,
          rows,
          cwd,
          env
        })
        console.warn(
          `[pty] Primary shell "${shellPath}" failed (${primaryError ?? 'unknown error'}), fell back to "${fallback}"`
        )
        return {
          process: proc,
          shellPath: fallback,
          reportsChildExitStatus: hostReportsChildExitStatus(wrapped.file)
        }
      } catch {
        // Fallback also failed -- try next.
      }
    }
  }

  const diag = formatLocalPtyEnvironmentDiag({ shell: shellPath, cwd })
  throw new Error(
    `Failed to spawn shell "${shellPath}": ${primaryError ?? 'unknown error'} (${diag}). ${TERMINAL_SPAWN_ISSUE_REQUEST}`
  )
}
