import { execFile } from 'node:child_process'
import { posix as pathPosix, win32 as pathWin32 } from 'node:path'
import { parseWslUncPath } from '../../shared/wsl-paths'

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
  /** Distro that executes Codex for this runtime home (RPC trust grants run
   *  codex inside it). */
  wslDistro: string
  /** Canonical Linux-side runtime home — CODEX_HOME for in-distro codex runs. */
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
export const WSL_CANONICAL_PATH_CACHE_MAX_ENTRIES = 256
export const WSL_CANONICAL_PATH_CACHE_MAX_UTF8_BYTES = 2 * 1024 * 1024

// Why: `readlink -f` over wsl.exe stalls up to the timeout on a cold or wedged
// distro. Running it synchronously on the Electron main process froze the UI on
// every Codex WSL launch, so resolve it off-thread and cache the latest result.
const canonicalWslPathCache = new Map<string, { canonicalPath: string; retainedBytes: number }>()
let canonicalWslPathCacheBytes = 0
const inFlightWslCanonicalizations = new Map<string, Set<WslCanonicalPathSettled>>()

function wslCanonicalizeCacheKey(distro: string, linuxPath: string): string {
  return `${distro}\x00${linuxPath}`
}

function getCachedWslCanonicalPath(key: string): string | null {
  const cached = canonicalWslPathCache.get(key)
  if (!cached) {
    return null
  }
  canonicalWslPathCache.delete(key)
  canonicalWslPathCache.set(key, cached)
  return cached.canonicalPath
}

function deleteCachedWslCanonicalPath(key: string): void {
  const cached = canonicalWslPathCache.get(key)
  if (!cached) {
    return
  }
  canonicalWslPathCache.delete(key)
  canonicalWslPathCacheBytes -= cached.retainedBytes
}

function cacheWslCanonicalPath(key: string, canonicalPath: string): void {
  deleteCachedWslCanonicalPath(key)
  const retainedBytes = Buffer.byteLength(key, 'utf8') + Buffer.byteLength(canonicalPath, 'utf8')
  if (retainedBytes > WSL_CANONICAL_PATH_CACHE_MAX_UTF8_BYTES) {
    return
  }
  while (
    canonicalWslPathCache.size >= WSL_CANONICAL_PATH_CACHE_MAX_ENTRIES ||
    canonicalWslPathCacheBytes + retainedBytes > WSL_CANONICAL_PATH_CACHE_MAX_UTF8_BYTES
  ) {
    const oldestKey = canonicalWslPathCache.keys().next().value as string | undefined
    if (oldestKey === undefined) {
      break
    }
    deleteCachedWslCanonicalPath(oldestKey)
  }
  canonicalWslPathCache.set(key, { canonicalPath, retainedBytes })
  canonicalWslPathCacheBytes += retainedBytes
}

function settleWslCanonicalization(key: string, settlement: WslCanonicalPathSettlement): void {
  if (settlement.status === 'resolved') {
    cacheWslCanonicalPath(key, settlement.canonicalPath)
  } else if (settlement.status === 'missing') {
    // Why: a successful directory probe is stronger than a transport error;
    // clear the identity so stale trust can be revoked and later rediscovered.
    deleteCachedWslCanonicalPath(key)
  }
  // Why: keep the last known-good cache on timeout/transient WSL failures.
  // Dropping it forces the next launch onto the logical `/mnt/...` guess,
  // which is wrong under custom automount roots and rewrites trust keys.
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
  // Why: wslpath reads each distro's automount root, so a custom root such as
  // /windows is discovered without synchronously starting WSL on Electron main.
  const args = drivePath
    ? [
        '-d',
        distro,
        '--',
        'sh',
        '-c',
        `resolved=$(wslpath -a -u "$1") || exit; if [ ! -d "$resolved" ]; then printf '%s\\n' '${WSL_PATH_MISSING_OUTPUT}'; exit 0; fi; readlink -f -- "$resolved"`,
        'sh',
        windowsPath
      ]
    : [
        '-d',
        distro,
        '--',
        'sh',
        '-c',
        `if [ ! -d "$1" ]; then printf '%s\\n' '${WSL_PATH_MISSING_OUTPUT}'; exit 0; fi; readlink -f -- "$1"`,
        'sh',
        linuxPath
      ]
  try {
    execFile(
      'wsl.exe',
      args,
      { encoding: 'utf-8', timeout: WSL_CANONICALIZE_TIMEOUT_MS, windowsHide: true },
      (error, stdout) => {
        const canonicalPath = stdout.trim()
        const resolvedPath = !error && canonicalPath.startsWith('/') ? canonicalPath : null
        const pathMissing = !error && canonicalPath === WSL_PATH_MISSING_OUTPUT
        settleWslCanonicalization(
          key,
          resolvedPath
            ? { status: 'resolved', canonicalPath: resolvedPath }
            : pathMissing
              ? { status: 'missing' }
              : { status: 'unavailable' }
        )
      }
    )
  } catch {
    settleWslCanonicalization(key, { status: 'unavailable' })
  }
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
  const cached = getCachedWslCanonicalPath(wslCanonicalizeCacheKey(distro, linuxPath))
  // Why: every launch revalidates asynchronously. Returning the cache keeps
  // launch prep synchronous while settlement repairs or revokes trust in-place.
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
  // Why: Codex canonicalizes hook sources inside WSL; resolving there keeps
  // trust keys valid when HOME or the runtime directory crosses a symlink.
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
    canonicalWslPathCacheBytes = 0
    inFlightWslCanonicalizations.clear()
  },
  getWslCanonicalPathCacheSize(): number {
    return canonicalWslPathCache.size
  },
  getWslCanonicalPathCacheBytes(): number {
    return canonicalWslPathCacheBytes
  }
}
