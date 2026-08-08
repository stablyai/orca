import { existsSync } from 'node:fs'
import { toWindowsWslPath } from '../../shared/wsl-paths'
import { getWslHome, listWslDistros } from '../wsl'

/** True for guest-absolute Linux paths that Win32 cannot open as-is. */
export function isGuestAbsoluteLinuxPath(path: string): boolean {
  if (!path.startsWith('/') || path.startsWith('//')) {
    return false
  }
  if (/^\/[A-Za-z]:(\/|$)/.test(path)) {
    return false
  }
  return true
}

export type HostReadableTranscriptPathDeps = {
  platform?: NodeJS.Platform
  pathExists?: (path: string) => boolean
  listDistros?: () => string[]
  getDistroHome?: (distro: string) => string | null
}

/**
 * Map a hook-reported transcript path to a path the local main process can open.
 * WSL hooks report guest Linux paths, which Windows must open through the owning distro.
 */
export function resolveHostReadableTranscriptPath(
  transcriptPath: string,
  deps: HostReadableTranscriptPathDeps = {}
): string | null {
  const path = transcriptPath.trim()
  if (!path) {
    return null
  }
  const pathExists = deps.pathExists ?? existsSync
  const platform = deps.platform ?? process.platform
  // Why: Node can resolve `/path` against the current Windows drive before WSL translation.
  const isWindowsGuestLinuxPath = platform === 'win32' && isGuestAbsoluteLinuxPath(path)
  if (!isWindowsGuestLinuxPath && pathExists(path)) {
    return path
  }
  if (!isWindowsGuestLinuxPath) {
    return null
  }

  // Why: drvfs paths map directly to a Windows drive even when WSL distro discovery is stale.
  if (/^\/mnt\/[a-z](?:\/|$)/.test(path)) {
    const hostPath = toWindowsWslPath(path, '')
    return pathExists(hostPath) ? hostPath : null
  }

  const listDistros = deps.listDistros ?? listWslDistros
  const getDistroHome = deps.getDistroHome ?? getWslHome
  const distros = listDistros()
  if (distros.length === 0) {
    return null
  }

  for (const distro of rankDistrosForLinuxPath(distros, path, getDistroHome)) {
    const uncPath = toWindowsWslPath(path, distro)
    if (pathExists(uncPath)) {
      return uncPath
    }
  }
  return null
}

function rankDistrosForLinuxPath(
  distros: readonly string[],
  linuxPath: string,
  getDistroHome: (distro: string) => string | null
): string[] {
  if (distros.length <= 1) {
    return [...distros]
  }
  const preferred: string[] = []
  const others: string[] = []
  for (const distro of distros) {
    const homeUnc = getDistroHome(distro)
    if (!homeUnc) {
      others.push(distro)
      continue
    }
    const homeLinux = homeUnc.replace(/\\/g, '/').replace(/^\/\/(wsl\.localhost|wsl\$)\/[^/]+/i, '')
    if (
      homeLinux &&
      homeLinux !== '/' &&
      (linuxPath === homeLinux || linuxPath.startsWith(`${homeLinux}/`))
    ) {
      preferred.push(distro)
    } else {
      others.push(distro)
    }
  }
  return preferred.length > 0 ? [...preferred, ...others] : [...distros]
}

/** WSL Claude roots used when the exact hook path is absent. */
export function wslClaudeProjectsDirs(
  deps: Pick<HostReadableTranscriptPathDeps, 'platform' | 'listDistros' | 'getDistroHome'> = {}
): string[] {
  const platform = deps.platform ?? process.platform
  if (platform !== 'win32') {
    return []
  }
  const listDistros = deps.listDistros ?? listWslDistros
  const getDistroHome = deps.getDistroHome ?? getWslHome
  const dirs: string[] = []
  for (const distro of listDistros()) {
    const home = getDistroHome(distro)
    if (home) {
      dirs.push(joinWindowsUnc(home, '.claude', 'projects'))
    }
  }
  return dirs
}

/** WSL Codex roots used when the exact hook path is absent. */
export function wslCodexSessionsDirs(
  deps: Pick<HostReadableTranscriptPathDeps, 'platform' | 'listDistros' | 'getDistroHome'> = {}
): string[] {
  const platform = deps.platform ?? process.platform
  if (platform !== 'win32') {
    return []
  }
  const listDistros = deps.listDistros ?? listWslDistros
  const getDistroHome = deps.getDistroHome ?? getWslHome
  const dirs: string[] = []
  for (const distro of listDistros()) {
    const home = getDistroHome(distro)
    if (!home) {
      continue
    }
    dirs.push(
      joinWindowsUnc(home, '.local', 'share', 'orca', 'codex-runtime-home', 'home', 'sessions')
    )
    dirs.push(joinWindowsUnc(home, '.codex', 'sessions'))
  }
  return dirs
}

// Why: node:path.join can collapse a WSL UNC share prefix on some Node builds.
function joinWindowsUnc(root: string, ...segments: string[]): string {
  const base = root.replace(/[\\/]+$/, '')
  const rest = segments.join('\\').replace(/^[\\/]+/, '')
  return `${base}\\${rest}`
}
