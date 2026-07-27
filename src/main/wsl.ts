import { execFile, execFileSync } from 'node:child_process'
import { parseWslUncPath, toWindowsWslPath } from '../shared/wsl-paths'

export { toWindowsWslPath } from '../shared/wsl-paths'

export type WslPathInfo = {
  distro: string
  linuxPath: string
}

/**
 * Detect if a Windows path is a WSL UNC path and extract the distro name
 * and equivalent Linux path.
 *
 * Why: Windows exposes WSL filesystems as UNC paths under \\wsl.localhost\<Distro>\...
 * (modern) or \\wsl$\<Distro>\... (legacy). When a repo lives on a WSL filesystem,
 * native Windows git.exe is either absent or painfully slow — all process spawning
 * must be routed through `wsl.exe -d <distro>` with Linux-native paths instead.
 */
export function parseWslPath(windowsPath: string): WslPathInfo | null {
  if (process.platform !== 'win32') {
    return null
  }

  return parseWslUncPath(windowsPath)
}

export function isWslPath(path: string): boolean {
  return parseWslPath(path) !== null
}

/**
 * Check whether a WSL UNC working directory exists by testing it inside the
 * distro itself, returning null when the answer can't be determined.
 *
 * Why: Win32 fs.statSync against the WSL 9P filesystem (\\wsl.localhost\...)
 * is unreliable for repos that live on the WSL side — it can report ENOENT for
 * directories that exist, which made opening a WSL worktree fail with
 * "Working directory ... does not exist". `wsl.exe -d <distro> test -d` asks
 * the distro directly, which is the authoritative answer. Returns null (rather
 * than false) when wsl.exe is unavailable or errors so callers can fall back to
 * the fs check instead of falsely rejecting a valid directory.
 */
export function wslUncDirectoryExists(uncPath: string): boolean | null {
  if (process.platform !== 'win32') {
    return null
  }
  const info = parseWslUncPath(uncPath)
  if (!info) {
    return null
  }
  try {
    execFileSync('wsl.exe', ['-d', info.distro, '--', 'test', '-d', info.linuxPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000
    })
    return true
  } catch (error) {
    // A non-zero exit (directory missing) surfaces as an error with a numeric
    // `status`; treat that as a definitive "does not exist". Any other failure
    // (wsl.exe missing, distro not running, timeout) is inconclusive -> null.
    if (typeof (error as { status?: unknown })?.status === 'number') {
      return false
    }
    return null
  }
}

/**
 * Convert a Windows path to a Linux path for commands that will execute inside WSL.
 * Returns the path unchanged if it is already POSIX-style.
 *
 * Why: WSL hook/setup environments may need both the worktree UNC path
 * (\\wsl.localhost\...) and regular Windows install paths (C:\Users\...)
 * translated before passing them to bash. Leaving drive paths untouched
 * breaks scripts that read ORCA_ROOT_PATH or similar env vars inside WSL.
 */
export function toLinuxPath(windowsPath: string): string {
  const info = parseWslPath(windowsPath)
  if (info) {
    return info.linuxPath
  }

  const driveMatch = windowsPath.match(/^([A-Za-z]):[/\\](.*)$/)
  if (!driveMatch) {
    return windowsPath
  }

  const driveLetter = driveMatch[1].toLowerCase()
  const rest = driveMatch[2].replace(/\\/g, '/')
  return `/mnt/${driveLetter}/${rest}`
}

// ─── WSL home directory resolution ──────────────────────────────────

const wslHomeCache = new Map<string, string>()
let wslDistroCache: string[] | null = null
// Why: a wsl.exe failure must stay retryable (a transient error would
// otherwise hide every distro until restart), but repeated failures cannot
// re-spawn a blocking wsl.exe on every caller; brief negative caching bounds
// the spawn rate on machines where WSL is absent or persistently broken.
const WSL_DISTRO_LIST_FAILURE_TTL_MS = 15_000
let wslDistroListFailedUntilMs = 0

function normalizeWslListOutput(output: string): string[] {
  // Why: wsl.exe can emit UTF-16-looking NUL bytes when inherited through
  // some Windows shells; strip them before line parsing.
  return output
    .replaceAll(String.fromCharCode(0), '')
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^\*\s*/, ''))
    .filter(Boolean)
}

function isUserWslDistro(distro: string): boolean {
  return !distro.toLowerCase().startsWith('docker-desktop')
}

export function listWslDistros(): string[] {
  if (wslDistroCache) {
    return wslDistroCache
  }

  if (process.platform !== 'win32') {
    wslDistroCache = []
    return wslDistroCache
  }

  if (Date.now() < wslDistroListFailedUntilMs) {
    return []
  }

  try {
    const output = execFileSync('wsl.exe', ['--list', '--quiet'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000
    })
    wslDistroCache = normalizeWslListOutput(output).filter(isUserWslDistro)
    return wslDistroCache
  } catch {
    wslDistroListFailedUntilMs = Date.now() + WSL_DISTRO_LIST_FAILURE_TTL_MS
    return []
  }
}

export async function listWslDistrosAsync(): Promise<string[]> {
  if (wslDistroCache !== null) {
    return wslDistroCache
  }

  if (process.platform !== 'win32') {
    wslDistroCache = []
    return wslDistroCache
  }

  if (Date.now() < wslDistroListFailedUntilMs) {
    return []
  }

  try {
    const output = await execFileUtf8('wsl.exe', ['--list', '--quiet'])
    wslDistroCache = normalizeWslListOutput(output).filter(isUserWslDistro)
    return wslDistroCache
  } catch {
    wslDistroListFailedUntilMs = Date.now() + WSL_DISTRO_LIST_FAILURE_TTL_MS
    return []
  }
}

export function hasCachedWslDistros(): boolean {
  return wslDistroCache !== null
}

export function getCachedWslDistros(): string[] | null {
  return wslDistroCache
}

export function getDefaultWslDistro(): string | null {
  return listWslDistros()[0] ?? null
}

/**
 * Get the home directory for a WSL distro, returned as a Windows UNC path.
 * Result is cached per distro for the process lifetime.
 *
 * Why: worktrees for WSL repos are created under ~/orca/workspaces inside
 * the WSL filesystem, mirroring the Windows workspace layout. We need the
 * WSL user's $HOME to compute that path.
 */
export function getWslHome(distro: string): string | null {
  if (wslHomeCache.has(distro)) {
    return wslHomeCache.get(distro)!
  }

  try {
    const home = execFileSync('wsl.exe', ['-d', distro, '--', 'bash', '-c', 'echo $HOME'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000
    }).trim()

    if (!home || !home.startsWith('/')) {
      return null
    }

    const uncPath = toWindowsWslPath(home, distro)
    wslHomeCache.set(distro, uncPath)
    return uncPath
  } catch {
    return null
  }
}

export async function getWslHomeAsync(distro: string): Promise<string | null> {
  if (wslHomeCache.has(distro)) {
    return wslHomeCache.get(distro)!
  }

  try {
    const home = (
      await execFileUtf8('wsl.exe', ['-d', distro, '--', 'bash', '-c', 'echo $HOME'])
    ).trim()

    if (!home || !home.startsWith('/')) {
      return null
    }

    const uncPath = toWindowsWslPath(home, distro)
    wslHomeCache.set(distro, uncPath)
    return uncPath
  } catch {
    return null
  }
}

// Cached WSL availability check — evaluated once per process lifetime
let wslAvailableCache: boolean | null = null

/**
 * Check whether wsl.exe is available and functional on this Windows machine.
 * Result is cached for the process lifetime.
 */
export function isWslAvailable(): boolean {
  if (wslAvailableCache !== null) {
    return wslAvailableCache
  }

  if (process.platform !== 'win32') {
    wslAvailableCache = false
    return false
  }

  try {
    execFileSync('wsl.exe', ['--status'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000
    })
    wslAvailableCache = true
  } catch {
    wslAvailableCache = false
  }

  return wslAvailableCache
}

export function hasCachedWslAvailability(): boolean {
  return wslAvailableCache !== null
}

export function getCachedWslAvailability(): boolean | null {
  return wslAvailableCache
}

export function _resetWslCachesForTests(): void {
  wslHomeCache.clear()
  wslDistroCache = null
  wslDistroListFailedUntilMs = 0
  wslAvailableCache = null
}

export function _setWslCachesForTests(args: {
  available?: boolean | null
  distros?: string[] | null
}): void {
  wslAvailableCache = args.available ?? null
  wslDistroCache = args.distros ?? null
}

function execFileUtf8(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: 'utf-8', timeout: 5000 }, (error, stdout) => {
      if (error) {
        reject(error)
        return
      }
      resolve(stdout)
    })
  })
}
