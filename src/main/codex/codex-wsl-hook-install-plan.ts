import { execFile } from 'node:child_process'
import { assertWslDistroAllowed } from '@orca/process-host/wsl-distro-allowlist'
import { posix as pathPosix, win32 as pathWin32 } from 'node:path'
import { parseWslUncPath } from '../../shared/wsl-paths'
import { resolveWslInteropSpawnCwd } from '../wsl-interop-spawn-directory'

export type CodexWslRuntimeHookTarget = {
  runtime?: 'host' | 'wsl'
  wslDistro?: string | null
}

export type CodexWslRuntimeHookInstallPlan = {
  configPath: string
  tomlPath: string
  scriptPath: string
  commandScriptPath: string
  trustConfigPath: string
  wslDistro: string
  /** Guest CODEX_HOME, canonical when resolution is available. */
  linuxRuntimeHome: string
}

export type WslCanonicalPathSettlement =
  | { status: 'resolved'; canonicalPath: string }
  | { status: 'missing' }
  | { status: 'unavailable' }

export type WslCanonicalPathSettled = (settlement: WslCanonicalPathSettlement) => void

export type CanonicalizeWslLinuxPath = (
  distro: string,
  linuxPath: string,
  windowsPath?: string,
  onSettled?: WslCanonicalPathSettled
) => string | null

function trimTrailingSlash(value: string): string {
  return value.length > 1 ? value.replace(/\/+$/, '') : value
}

function toDefaultWslLinuxPath(windowsPath: string): string {
  const driveMatch = windowsPath.match(/^([A-Za-z]):[/\\](.*)$/)
  if (!driveMatch) {
    return windowsPath
  }
  return `/mnt/${driveMatch[1].toLowerCase()}/${driveMatch[2].replace(/\\/g, '/')}`
}

const WSL_CANONICALIZE_TIMEOUT_MS = 5000
const WSL_PATH_MISSING_OUTPUT = '__ORCA_WSL_PATH_MISSING__'
export const MAX_WSL_CANONICAL_PATH_CACHE_ENTRIES = 512

// Canonicalize asynchronously and cache results so cold WSL startup cannot block the main thread.
const canonicalWslPathCache = new Map<string, string>()
const inFlightWslCanonicalizations = new Map<string, Set<WslCanonicalPathSettled>>()

function rememberCanonicalWslPath(key: string, value: string): void {
  canonicalWslPathCache.delete(key)
  canonicalWslPathCache.set(key, value)
  while (canonicalWslPathCache.size > MAX_WSL_CANONICAL_PATH_CACHE_ENTRIES) {
    const oldest = canonicalWslPathCache.keys().next()
    if (oldest.done) {
      break
    }
    canonicalWslPathCache.delete(oldest.value)
  }
}

function wslCanonicalizeCacheKey(distro: string, linuxPath: string): string {
  return `${distro}\x00${linuxPath}`
}

function scheduleWslLinuxPathCanonicalization(
  distro: string,
  linuxPath: string,
  windowsPath: string,
  onSettled?: WslCanonicalPathSettled
): void {
  const key = wslCanonicalizeCacheKey(distro, linuxPath)
  const listeners = inFlightWslCanonicalizations.get(key)
  if (listeners) {
    if (onSettled) {
      listeners.add(onSettled)
    }
    return
  }
  const nextListeners = new Set<WslCanonicalPathSettled>()
  if (onSettled) {
    nextListeners.add(onSettled)
  }
  inFlightWslCanonicalizations.set(key, nextListeners)
  const drivePath = /^[A-Za-z]:[/\\]/.test(windowsPath)
  // wslpath honors the distro's custom automount root.
  const args = drivePath
    ? [
        '-d',
        distro,
        '--exec',
        'sh',
        '-c',
        `resolved=$(wslpath -a -u "$1") || exit; if [ ! -d "$resolved" ]; then printf '%s\\n' '${WSL_PATH_MISSING_OUTPUT}'; exit 0; fi; readlink -f -- "$resolved"`,
        'sh',
        windowsPath
      ]
    : [
        '-d',
        distro,
        '--exec',
        'sh',
        '-c',
        `if [ ! -d "$1" ]; then printf '%s\\n' '${WSL_PATH_MISSING_OUTPUT}'; exit 0; fi; readlink -f -- "$1"`,
        'sh',
        linuxPath
      ]
  const settle = (error: Error | null, stdout: string): void => {
    const canonicalPath = stdout.trim()
    const resolvedPath = !error && canonicalPath.startsWith('/') ? canonicalPath : null
    const pathMissing = !error && canonicalPath === WSL_PATH_MISSING_OUTPUT
    const settlement: WslCanonicalPathSettlement = resolvedPath
      ? { status: 'resolved', canonicalPath: resolvedPath }
      : pathMissing
        ? { status: 'missing' }
        : { status: 'unavailable' }
    if (settlement.status === 'resolved') {
      rememberCanonicalWslPath(key, canonicalPath)
    } else if (settlement.status === 'missing') {
      // Confirmed absence invalidates cached trust identity.
      canonicalWslPathCache.delete(key)
    }
    // Retain known-good identity on transport errors; /mnt guesses can rewrite valid custom-root trust.
    const settledListeners = inFlightWslCanonicalizations.get(key) ?? new Set()
    inFlightWslCanonicalizations.delete(key)
    for (const listener of settledListeners) {
      try {
        listener(settlement)
      } catch (listenerError) {
        console.warn('[codex-wsl-hook-path] failed to reconcile canonical path', listenerError)
      }
    }
  }
  try {
    assertWslDistroAllowed('wsl.exe', args)
  } catch (error) {
    // Settle asynchronously, as a failed exec would.
    queueMicrotask(() => settle(error instanceof Error ? error : new Error(String(error)), ''))
    return
  }
  execFile(
    'wsl.exe',
    args,
    {
      encoding: 'utf-8',
      timeout: WSL_CANONICALIZE_TIMEOUT_MS,
      windowsHide: true,
      cwd: resolveWslInteropSpawnCwd()
    },
    settle
  )
}

function canonicalizeWslLinuxPath(
  distro: string,
  linuxPath: string,
  windowsPath = linuxPath,
  onSettled?: WslCanonicalPathSettled
): string | null {
  if (process.platform !== 'win32') {
    return linuxPath
  }
  const cacheKey = wslCanonicalizeCacheKey(distro, linuxPath)
  const cached = canonicalWslPathCache.get(cacheKey)
  if (cached !== undefined) {
    rememberCanonicalWslPath(cacheKey, cached)
  }
  // Return cached identity during asynchronous revalidation; settlement reconciles trust.
  scheduleWslLinuxPathCanonicalization(distro, linuxPath, windowsPath, onSettled)
  return cached ?? null
}

export function createCodexWslRuntimeHookInstallPlan(
  runtimeHomePath: string | null | undefined,
  target?: CodexWslRuntimeHookTarget,
  canonicalize: CanonicalizeWslLinuxPath = canonicalizeWslLinuxPath,
  onCanonicalPathSettled?: WslCanonicalPathSettled
): CodexWslRuntimeHookInstallPlan | null {
  if (!runtimeHomePath) {
    return null
  }

  const wslInfo = parseWslUncPath(runtimeHomePath)
  if (!wslInfo && target?.runtime !== 'wsl') {
    return null
  }
  const distro = wslInfo?.distro || (target?.runtime === 'wsl' ? target.wslDistro?.trim() : null)
  if (!distro) {
    return null
  }

  const logicalLinuxRuntimeHome = wslInfo?.linuxPath ?? toDefaultWslLinuxPath(runtimeHomePath)
  if (!logicalLinuxRuntimeHome.startsWith('/')) {
    return null
  }
  // Match Codex's guest-side canonicalization so symlinks cannot change the trust key.
  const linuxRuntimeHome = trimTrailingSlash(
    canonicalize(distro, logicalLinuxRuntimeHome, runtimeHomePath, onCanonicalPathSettled) ??
      logicalLinuxRuntimeHome
  )

  return {
    configPath: pathWin32.join(runtimeHomePath, 'hooks.json'),
    tomlPath: pathWin32.join(runtimeHomePath, 'config.toml'),
    scriptPath: pathWin32.join(runtimeHomePath, '.orca', 'agent-hooks', 'codex-hook.sh'),
    commandScriptPath: pathPosix.join(linuxRuntimeHome, '.orca', 'agent-hooks', 'codex-hook.sh'),
    trustConfigPath: pathPosix.join(linuxRuntimeHome, 'hooks.json'),
    wslDistro: distro,
    linuxRuntimeHome
  }
}

export const _internals = {
  canonicalizeWslLinuxPath,
  resetWslCanonicalPathCache(): void {
    canonicalWslPathCache.clear()
    inFlightWslCanonicalizations.clear()
  },
  getWslCanonicalPathCacheSizeForTests(): number {
    return canonicalWslPathCache.size
  }
}
