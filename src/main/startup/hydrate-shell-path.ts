import { spawn } from 'node:child_process'
import { delimiter, win32 as pathWin32 } from 'node:path'
import type { ShellHydrationFailureReason } from '../../shared/types'
import { resolveWindowsShellStartupFamily } from '../../shared/windows-terminal-shell'
import { WindowsShellPathOwnership, windowsPathSegmentKey } from './windows-shell-path-ownership'

// Why: GUI-launched Electron can miss PATH entries added by shell profiles.
// Tools installed into ~/.opencode/bin, ~/.cargo/bin, pyenv/volta/fnm
// shims, and countless other user-local locations end up invisible to our
// `which` probe even though they work fine from Terminal (see stablyai/orca#829).
//
// Probe the profile-loading shell once instead of hard-coding every tool's install path.

const DELIMITER = '__ORCA_SHELL_PATH__'
const SPAWN_TIMEOUT_MS = 5000

// ANSI escape sequences can leak into the captured output when the user's rc
// files print banners or set colored prompts. Strip them before parsing.
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g // eslint-disable-line no-control-regex

// Why: the discriminator lets telemetry classify *why* hydration failed, not
// just whether it did. Five resolve sites in this file each tag the result
// with the right reason. The shared alias keeps the enum in lockstep with the
// telemetry schema (compile-time guard in telemetry-events.ts).
export type HydrationResult =
  | { ok: true; segments: string[]; failureReason: 'none' }
  | {
      ok: false
      segments: []
      failureReason: Exclude<ShellHydrationFailureReason, 'none'>
    }

let cached: Promise<HydrationResult> | null = null
let probeQueue = Promise.resolve()
let configuredWindowsShell = 'powershell.exe'
let configuredWindowsGitBashPath: string | null = null
let configuredWindowsFallbackShell: string | null = null
let windowsShellConfigurationVersion = 0
const windowsPathOwnership = new WindowsShellPathOwnership()

/** @internal - tests need a clean hydration cache between cases. */
export function _resetHydrateShellPathCache(): void {
  cached = null
  probeQueue = Promise.resolve()
  configuredWindowsShell = 'powershell.exe'
  configuredWindowsGitBashPath = null
  configuredWindowsFallbackShell = null
  windowsShellConfigurationVersion = 0
  windowsPathOwnership.reset()
}

function pickShell(): string | null {
  if (process.platform === 'win32') {
    const family = resolveWindowsShellStartupFamily(configuredWindowsShell)
    if (family === 'cmd') {
      return null
    }
    if (family === 'posix') {
      return configuredWindowsGitBashPath
    }
    const basename = pathWin32.basename(configuredWindowsShell).toLowerCase()
    return basename === 'powershell.exe' || basename === 'pwsh.exe' ? configuredWindowsShell : null
  }
  const shell = process.env.SHELL
  if (shell && shell.length > 0) {
    return shell
  }
  return process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash'
}

function parseCapturedPath(stdout: string, pathDelimiter: string = delimiter): string[] {
  const cleaned = stdout.replace(ANSI_RE, '')
  const first = cleaned.indexOf(DELIMITER)
  if (first === -1) {
    return []
  }
  const second = cleaned.indexOf(DELIMITER, first + DELIMITER.length)
  if (second === -1) {
    return []
  }
  const value = cleaned.slice(first + DELIMITER.length, second).trim()
  if (!value) {
    return []
  }
  // Why: Set preserves insertion order, and PATH resolution is first-match-wins,
  // so de-duping this way keeps the user's rc-file ordering intact.
  return [
    ...new Set(
      value
        .split(pathDelimiter)
        .map((s) => s.trim())
        .filter(Boolean)
    )
  ]
}

function shellPathProbe(shell: string): { args: string[]; pathDelimiter: string } {
  if (process.platform !== 'win32') {
    const command = `printf '%s' '${DELIMITER}'; printf '%s' "$PATH"; printf '%s' '${DELIMITER}'`
    return { args: ['-ilc', command], pathDelimiter: delimiter }
  }
  if (resolveWindowsShellStartupFamily(shell) === 'posix') {
    // Why: native child processes cannot resolve Git Bash's /c/... PATH entries.
    const command = `printf '%s' '${DELIMITER}'; cygpath -wp "$PATH"; printf '%s' '${DELIMITER}'`
    return { args: ['-ilc', command], pathDelimiter: ';' }
  }
  const command =
    `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); ` +
    `[Console]::Write('${DELIMITER}'); [Console]::Write($env:Path); ` +
    `[Console]::Write('${DELIMITER}')`
  // Why: omitting -NoProfile is the behavior this probe exists to capture.
  return { args: ['-NoLogo', '-Command', command], pathDelimiter: ';' }
}

function spawnShellAndReadPath(shell: string): Promise<HydrationResult> {
  return new Promise((resolve) => {
    // Why: delimiters isolate PATH from profile banners and MOTDs.
    const probe = shellPathProbe(shell)
    let finished = false
    let stdout = ''
    let timer: ReturnType<typeof setTimeout> | null = null

    const child = spawn(shell, probe.args, {
      // Why: inherit current env so the shell sees the same baseline, then let
      // it layer its own rc files on top. Do NOT forward stdio — some shells
      // (oh-my-zsh setups, powerlevel10k) print a lot to stderr on startup,
      // and we don't want that in Orca's console.
      env: process.env,
      stdio: ['ignore', 'pipe', 'ignore'],
      detached: false,
      windowsHide: true
    })

    const cleanup = (): void => {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      child.stdout.off('data', onStdoutData)
      child.off('error', onError)
      child.off('close', onClose)
    }
    const finish = (result: HydrationResult): void => {
      if (finished) {
        return
      }
      finished = true
      cleanup()
      resolve(result)
    }

    timer = setTimeout(() => {
      // Why: slow rc files (corporate env setup, nvm eager init) can exceed
      // our budget. Kill the shell and fall back to process.env rather than
      // blocking the Agents pane indefinitely.
      try {
        child.kill('SIGKILL')
      } catch {
        // ignore
      }
      finish({ segments: [], ok: false, failureReason: 'timeout' })
    }, SPAWN_TIMEOUT_MS)

    const onStdoutData = (chunk: Buffer): void => {
      stdout += chunk.toString('utf8')
    }

    const onError = (): void => {
      finish({ segments: [], ok: false, failureReason: 'spawn_error' })
    }

    const onClose = (): void => {
      const segments = parseCapturedPath(stdout, probe.pathDelimiter)
      if (segments.length === 0) {
        finish({ segments: [], ok: false, failureReason: 'empty_path' })
        return
      }
      finish({ segments, ok: true, failureReason: 'none' })
    }

    child.stdout.on('data', onStdoutData)
    child.on('error', onError)
    child.on('close', onClose)
  })
}

type HydrateOptions = {
  force?: boolean
  /** Override for tests — defaults to running `spawn` against the real shell. */
  spawner?: (shell: string) => Promise<HydrationResult>
  /** Override for tests — defaults to `pickShell()`. */
  shellOverride?: string | null
}

/**
 * Spawn the user's profile-loading shell once and return the PATH it would export.
 * Caches the promise for the lifetime of the process — call
 * `_resetHydrateShellPathCache()` in tests or `hydrateShellPath({ force: true })`
 * when the user asks to re-probe (e.g. after installing a new CLI).
 */
export function hydrateShellPath(options: HydrateOptions = {}): Promise<HydrationResult> {
  if (cached && !options.force) {
    return cached
  }
  const platform = process.platform
  const configurationVersion = windowsShellConfigurationVersion
  const shell = options.shellOverride !== undefined ? options.shellOverride : pickShell()
  if (!shell) {
    cached = Promise.resolve({ segments: [], ok: false, failureReason: 'no_shell' })
    return cached
  }
  const spawner = options.spawner ?? spawnShellAndReadPath
  const fallbackShell = options.shellOverride === undefined ? configuredWindowsFallbackShell : null
  const probe = probeQueue.then(async () => {
    if (platform === 'win32') {
      windowsPathOwnership.restore(process.env)
    }
    const result = await spawner(shell)
    if (!result.ok && result.failureReason === 'spawn_error' && fallbackShell) {
      return spawner(fallbackShell)
    }
    return result
  })
  // Why: one rejected profile must not block later refreshes or shell changes.
  probeQueue = probe.then(
    () => undefined,
    () => undefined
  )
  cached = probe.then((result) => {
    if (
      platform === 'win32' &&
      options.shellOverride === undefined &&
      configurationVersion !== windowsShellConfigurationVersion
    ) {
      return hydrateShellPath()
    }
    return result
  })
  return cached
}

export function configureWindowsShellPathHydration(
  shell: string | null | undefined,
  gitBashPath: string | null = null,
  fallbackShell: string | null = null
): void {
  const next = shell?.trim() || 'powershell.exe'
  if (
    next === configuredWindowsShell &&
    gitBashPath === configuredWindowsGitBashPath &&
    fallbackShell === configuredWindowsFallbackShell
  ) {
    return
  }
  windowsPathOwnership.restore(process.env)
  configuredWindowsShell = next
  configuredWindowsGitBashPath = gitBashPath
  configuredWindowsFallbackShell = fallbackShell
  windowsShellConfigurationVersion += 1
  cached = null
}

function uniquePathSegments(segments: string[], pathKey: (segment: string) => string): string[] {
  const seen = new Set<string>()
  return segments.filter((segment) => {
    const key = pathKey(segment)
    if (seen.has(key)) {
      return false
    }
    seen.add(key)
    return true
  })
}

/**
 * Promote shell-discovered PATH segments to the front of process.env.PATH,
 * preserving shell ordering and avoiding duplicates. Returns the segments that
 * were newly added so callers can log/telemetry on nontrivial hydrations.
 */
export function mergePathSegments(segments: string[]): string[] {
  if (segments.length === 0) {
    return []
  }
  if (process.platform === 'win32') {
    windowsPathOwnership.restore(process.env)
  }
  const current = process.env.PATH ?? process.env.Path ?? ''
  const pathDelimiter = process.platform === 'win32' ? pathWin32.delimiter : delimiter
  const currentSegments = current.split(pathDelimiter).filter(Boolean)
  const pathKey =
    process.platform === 'win32' ? windowsPathSegmentKey : (segment: string): string => segment
  const shellSegments = uniquePathSegments(segments, pathKey)
  const shellSegmentSet = new Set(shellSegments.map(pathKey))
  const existing = new Set(currentSegments.map(pathKey))
  const added = shellSegments.filter((segment) => !existing.has(pathKey(segment)))
  const merged = [
    ...shellSegments,
    ...currentSegments.filter((segment) => !shellSegmentSet.has(pathKey(segment)))
  ]
  const next = merged.join(pathDelimiter)
  if (next === current) {
    return []
  }
  // Why: shell-provided entries must win over hardcoded packaged-app fallbacks.
  // A seeded fallback can point at a stale CLI while the user's shell resolves
  // a healthy one from the same directory list in a different order.
  if (process.platform === 'win32') {
    windowsPathOwnership.apply(process.env, next)
  } else {
    process.env.PATH = next
  }
  return added
}
