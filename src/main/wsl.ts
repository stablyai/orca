import { execFileSync } from 'child_process'

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

  // Normalize backslashes to forward slashes for uniform matching
  const normalized = windowsPath.replace(/\\/g, '/')

  // Match //wsl.localhost/Distro/... or //wsl$/Distro/...
  const match = normalized.match(/^\/\/(wsl\.localhost|wsl\$)\/([^/]+)(\/.*)?$/)
  if (!match) {
    return null
  }

  return {
    distro: match[2],
    linuxPath: match[3] || '/'
  }
}

export function isWslPath(path: string): boolean {
  return parseWslPath(path) !== null
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

/**
 * Convert a Linux path inside a WSL distro to a Windows path.
 *
 * Why two forms: paths under /mnt/<drive>/... are Windows-native filesystem
 * paths that WSL exposes via the DrvFs mount. These map back to their native
 * Windows form (e.g. /mnt/c/Users → C:\Users). All other paths live on the
 * WSL virtual filesystem and use the UNC form (\\wsl.localhost\Distro\...).
 */
export function toWindowsWslPath(linuxPath: string, distro: string): string {
  // /mnt/c/Users/... → C:\Users\...
  const mntMatch = linuxPath.match(/^\/mnt\/([a-z])(\/.*)?$/)
  if (mntMatch) {
    const driveLetter = mntMatch[1].toUpperCase()
    const rest = (mntMatch[2] || '').replace(/\//g, '\\')
    return `${driveLetter}:${rest || '\\'}`
  }

  return `\\\\wsl.localhost\\${distro}${linuxPath.replace(/\//g, '\\')}`
}

// ─── WSL home directory resolution ──────────────────────────────────

const wslHomeCache = new Map<string, string>()

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
