import type { SpawnedProcess } from '@orca/process-host/process-spec'
import { delimiter, win32 as pathWin32 } from 'node:path'
import { spawnProcess } from '@orca/process-host'
import { stripAnsiEscapeSequences } from '../../shared/ansi-escape-sequences'
import type { ShellHydrationFailureReason } from '../../shared/shell-path-hydration-types'
import { resolveWindowsShellStartupFamily } from '../../shared/windows-terminal-shell'
import { SHELL_PATH_DELIMITER as DELIMITER, shellPathProbe } from './shell-path-probe'
import { WindowsShellPathOwnership, createWindowsPathKey } from './windows-shell-path-ownership'

// GUI launches miss shell-profile PATH entries; probe the login shell instead of hardcoding every tool directory.

// Loaded profiles measured 6-7s, exceeding 5s. Ten seconds extends Windows terminal/Git gating only for already-slow profiles; POSIX startup remains fire-and-forget.
const SPAWN_TIMEOUT_MS = 10_000

// Share the telemetry failure taxonomy so resolve sites and schema cannot drift.
export type HydrationResult =
  | { ok: true; segments: string[]; failureReason: 'none' }
  | {
      ok: false
      segments: []
      failureReason: Exclude<ShellHydrationFailureReason, 'none'>
    }

let cached: Promise<HydrationResult> | null = null
let probeQueue = Promise.resolve()
// Snapshot before main-body seeding: nvm may prefer seeded node over its default alias. Capture Windows Path casing too, including Git Bash nvm layouts.
const LAUNCH_PATH_KEY =
  process.platform === 'win32' && process.env.Path !== undefined ? 'Path' : 'PATH'
const LAUNCH_PATH = process.env[LAUNCH_PATH_KEY] ?? null
// Allow heavy rc files to recognize the probe and skip multiplexers/prompts.
export const PROBE_MARKER_ENV_VAR = 'ORCA_SHELL_PATH_PROBE'
let launchPathOverride: { key: string; value: string } | null = null
let configuredWindowsShell = 'powershell.exe'
let configuredWindowsGitBashPath: string | null = null
let configuredWindowsFallbackShell: string | null = null
let windowsShellConfigurationVersion = 0
const windowsPathOwnership = new WindowsShellPathOwnership()

/** @internal - tests need a clean hydration cache between cases. */
export function _resetHydrateShellPathCache(): void {
  cached = null
  probeQueue = Promise.resolve()
  launchPathOverride = null
  configuredWindowsShell = 'powershell.exe'
  configuredWindowsGitBashPath = null
  configuredWindowsFallbackShell = null
  windowsShellConfigurationVersion = 0
  windowsPathOwnership.reset()
}

export function resolveProfileLoadingShell(): string | null {
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
  return shell?.length ? shell : process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash'
}

export const resolveProfileLoadingFallbackShell = (): string | null =>
  configuredWindowsFallbackShell

function parseCapturedPath(stdout: string, pathDelimiter: string = delimiter): string[] {
  // Why: rc-file banners and colored prompts can leak escapes into the captured output.
  const cleaned = stripAnsiEscapeSequences(stdout)
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
  // Preserve first-match-wins shell order while deduplicating.
  return [
    ...new Set(
      value
        .split(pathDelimiter)
        .map((s) => s.trim())
        .filter(Boolean)
    )
  ]
}

/** @internal - tests need a launch PATH the runner's own environment cannot supply. */
export function _setLaunchPathForTests(value: string, key = 'PATH'): void {
  launchPathOverride = { key, value }
}

function isLaunchPathKey(name: string, key: string): boolean {
  return process.platform === 'win32' ? name.toLowerCase() === key.toLowerCase() : name === key
}

function applyLaunchPath(env: NodeJS.ProcessEnv, key: string, value: string | null): void {
  if (value === null) {
    return
  }
  // Windows env names ignore case; remove alternate spellings from this plain object.
  for (const name of Object.keys(env)) {
    if (name !== key && isLaunchPathKey(name, key)) {
      delete env[name]
    }
  }
  env[key] = value
}

function shellProbeEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, [PROBE_MARKER_ENV_VAR]: '1' }
  const key = launchPathOverride?.key ?? LAUNCH_PATH_KEY
  const value = launchPathOverride?.value ?? LAUNCH_PATH
  applyLaunchPath(env, key, value)
  return env
}

/** Run a synchronous launcher without passing Orca's seeded PATH to its child. */
export function runWithLaunchPath<T>(action: () => T): T {
  const key = launchPathOverride?.key ?? LAUNCH_PATH_KEY
  const value = launchPathOverride?.value ?? LAUNCH_PATH
  if (value === null) {
    return action()
  }
  const previous = Object.entries(process.env).filter(([name]) => isLaunchPathKey(name, key))
  applyLaunchPath(process.env, key, value)
  try {
    return action()
  } finally {
    for (const name of Object.keys(process.env)) {
      if (isLaunchPathKey(name, key)) {
        delete process.env[name]
      }
    }
    for (const [name, previousValue] of previous) {
      process.env[name] = previousValue
    }
  }
}

function spawnShellAndReadPath(shell: string): Promise<HydrationResult> {
  return new Promise((resolve) => {
    const probe = shellPathProbe(shell)
    let finished = false
    let stdout = ''
    let timer: ReturnType<typeof setTimeout> | null = null

    let child: SpawnedProcess
    try {
      child = spawnProcess({
        program: shell,
        args: probe.args,
        // Preserve environment for rc setup while suppressing noisy shell stderr and ignoring stdin.
        env: shellProbeEnv(),
        stdio: ['ignore', 'pipe', 'ignore'],
        detached: false
      })
    } catch {
      // Synchronous spawn failure (for example Store pwsh EPERM) must reach fallback selection.
      resolve({ segments: [], ok: false, failureReason: 'spawn_error' })
      return
    }

    const cleanup = (): void => {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      child.stdout?.off('data', onStdoutData)
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
      // Bound slow rc setup so agent discovery can fall back rather than wait forever.
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

    child.stdout?.on('data', onStdoutData)
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

/** Cache the profile-loading shell probe for this process; force re-probe after tool installation. */
export function hydrateShellPath(options: HydrateOptions = {}): Promise<HydrationResult> {
  if (cached && !options.force) {
    return cached
  }
  const platform = process.platform
  const configurationVersion = windowsShellConfigurationVersion
  const shell =
    options.shellOverride !== undefined ? options.shellOverride : resolveProfileLoadingShell()
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
  // Rejected profiles must not block later refreshes or shell changes.
  probeQueue = probe.then(
    () => undefined,
    () => undefined
  )
  const hydration = probe.then((result) => {
    if (
      platform === 'win32' &&
      options.shellOverride === undefined &&
      configurationVersion !== windowsShellConfigurationVersion
    ) {
      return hydrateShellPath()
    }
    return result
  })
  cached = hydration
  // Evict rejected cache promises so later callers can re-probe.
  hydration.catch(() => {
    if (cached === hydration) {
      cached = null
    }
  })
  return hydration
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

/** Shell order wins over seeded PATH; report newly added segments for diagnostics. */
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
    process.platform === 'win32' ? createWindowsPathKey() : (segment: string): string => segment
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
  // Shell ordering must override seeded fallbacks that may resolve stale CLIs.
  if (process.platform === 'win32') {
    windowsPathOwnership.apply(process.env, next)
  } else {
    process.env.PATH = next
  }
  return added
}
