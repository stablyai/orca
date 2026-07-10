import { execFile } from 'node:child_process'
import { win32 as pathWin32 } from 'node:path'
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
}

export type CanonicalizeWslLinuxPath = (distro: string, linuxPath: string) => string | null

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

// Why: `readlink -f` over wsl.exe stalls up to the timeout on a cold or wedged
// distro. Running it synchronously on the Electron main process froze the UI on
// every Codex WSL launch, so resolve it off-thread and cache the stable result.
const canonicalWslPathCache = new Map<string, string>()
const inFlightWslCanonicalizations = new Set<string>()

function wslCanonicalizeCacheKey(distro: string, linuxPath: string): string {
  return `${distro}\x00${linuxPath}`
}

function scheduleWslLinuxPathCanonicalization(distro: string, linuxPath: string): void {
  const key = wslCanonicalizeCacheKey(distro, linuxPath)
  // Why: cap the wedged-WSL blast radius to a single background subprocess per
  // (distro, path); the cache holds the answer once one resolution succeeds.
  if (canonicalWslPathCache.has(key) || inFlightWslCanonicalizations.has(key)) {
    return
  }
  inFlightWslCanonicalizations.add(key)
  execFile(
    'wsl.exe',
    ['-d', distro, '--', 'readlink', '-f', '--', linuxPath],
    { encoding: 'utf-8', timeout: WSL_CANONICALIZE_TIMEOUT_MS, windowsHide: true },
    (error, stdout) => {
      inFlightWslCanonicalizations.delete(key)
      if (error) {
        return
      }
      const canonicalPath = stdout.trim()
      if (canonicalPath.startsWith('/')) {
        canonicalWslPathCache.set(key, canonicalPath)
      }
    }
  )
}

function canonicalizeWslLinuxPath(distro: string, linuxPath: string): string | null {
  if (process.platform !== 'win32') {
    return linuxPath
  }
  const cached = canonicalWslPathCache.get(wslCanonicalizeCacheKey(distro, linuxPath))
  if (cached) {
    return cached
  }
  // Why: no canonical path resolved yet — start the off-thread resolution and
  // let the caller use the logical path for now (identical unless HOME crosses a
  // symlink). The next launch reads the cached canonical path.
  scheduleWslLinuxPathCanonicalization(distro, linuxPath)
  return null
}

export function createCodexWslRuntimeHookInstallPlan(
  runtimeHomePath: string | null | undefined,
  target?: CodexWslRuntimeHookTarget,
  canonicalize: CanonicalizeWslLinuxPath = canonicalizeWslLinuxPath
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
    canonicalize(distro, logicalLinuxRuntimeHome) ?? logicalLinuxRuntimeHome
  )

  return {
    configPath: pathWin32.join(runtimeHomePath, 'hooks.json'),
    tomlPath: pathWin32.join(runtimeHomePath, 'config.toml'),
    scriptPath: pathWin32.join(runtimeHomePath, '.orca', 'agent-hooks', 'codex-hook.sh'),
    commandScriptPath: `${linuxRuntimeHome}/.orca/agent-hooks/codex-hook.sh`,
    trustConfigPath: `${linuxRuntimeHome}/hooks.json`
  }
}

export const _internals = {
  canonicalizeWslLinuxPath,
  resetWslCanonicalPathCache(): void {
    canonicalWslPathCache.clear()
    inFlightWslCanonicalizations.clear()
  }
}
