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

// Why: `readlink -f` over wsl.exe stalls up to the timeout on a cold or wedged
// distro. Running it synchronously on the Electron main process froze the UI on
// every Codex WSL launch, so resolve it off-thread and cache the latest result.
const canonicalWslPathCache = new Map<string, string>()
const inFlightWslCanonicalizations = new Map<string, Set<WslCanonicalPathSettled>>()

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
  execFile(
    'wsl.exe',
    args,
    { encoding: 'utf-8', timeout: WSL_CANONICALIZE_TIMEOUT_MS, windowsHide: true },
    (error, stdout) => {
      const canonicalPath = stdout.trim()
      const resolvedPath = !error && canonicalPath.startsWith('/') ? canonicalPath : null
      const pathMissing = !error && canonicalPath === WSL_PATH_MISSING_OUTPUT
      const settlement: WslCanonicalPathSettlement = resolvedPath
        ? { status: 'resolved', canonicalPath: resolvedPath }
        : pathMissing
          ? { status: 'missing' }
          : { status: 'unavailable' }
      if (settlement.status === 'resolved') {
        canonicalWslPathCache.set(key, canonicalPath)
      } else if (settlement.status === 'missing') {
        // Why: a successful directory probe is stronger than a transport error;
        // clear the identity so stale trust can be revoked and later rediscovered.
        canonicalWslPathCache.delete(key)
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
  const cached = canonicalWslPathCache.get(wslCanonicalizeCacheKey(distro, linuxPath))
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
    inFlightWslCanonicalizations.clear()
  }
}
