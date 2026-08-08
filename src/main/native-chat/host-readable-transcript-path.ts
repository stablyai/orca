import { existsSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { toWindowsWslPath } from '../../shared/wsl-paths'
import { getWslHome, listWslDistros } from '../wsl'

/**
 * True for guest-absolute Linux paths that Win32 cannot open as-is.
 * Drive letters, UNC shares, and relative paths are left alone.
 */
export function isGuestAbsoluteLinuxPath(path: string): boolean {
  if (!path.startsWith('/') || path.startsWith('//')) {
    return false
  }
  // Why: a Windows drive path normalized with forward slashes (`C:/…`) must not
  // be rewritten as a WSL guest path.
  if (/^\/[A-Za-z]:(\/|$)/.test(path)) {
    return false
  }
  return isAbsolute(path)
}

export type HostReadableTranscriptPathDeps = {
  platform?: NodeJS.Platform
  pathExists?: (path: string) => boolean
  listDistros?: () => string[]
  /** Optional: prefer the distro whose home prefixes the Linux path. */
  getDistroHome?: (distro: string) => string | null
}

/**
 * Map a hook-reported transcript path to a path the local main process can open.
 *
 * WSL Codex/Claude hooks report Linux paths (`/home/…/rollout-….jsonl`). On
 * Windows the main process must open the equivalent `\\wsl.localhost\…` UNC
 * form; without this, Chat UI never finds the live transcript (#10326/#10523).
 *
 * When the raw path already exists (macOS/Linux hosts, or a pre-translated UNC)
 * it is returned unchanged. When translation is needed, each installed distro
 * is tried and the first existing UNC wins. Distros whose $HOME prefixes the
 * guest path are preferred so multi-distro machines pick the right owner.
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
  // Why: on Windows, classify guest Linux paths before pathExists — Node can
  // treat `/exists` as a drive-relative local path (`C:\exists`) and falsely
  // return the local file instead of translating to a WSL UNC.
  const isWindowsGuestLinuxPath = platform === 'win32' && isGuestAbsoluteLinuxPath(path)
  if (!isWindowsGuestLinuxPath && pathExists(path)) {
    return path
  }

  if (!isWindowsGuestLinuxPath) {
    return null
  }

  const listDistros = deps.listDistros ?? listWslDistros
  const getDistroHome = deps.getDistroHome ?? getWslHome
  const distros = listDistros()
  if (distros.length === 0) {
    return null
  }

  const ranked = rankDistrosForLinuxPath(distros, path, getDistroHome)
  for (const distro of ranked) {
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
    // getWslHome returns a Windows UNC for $HOME; convert back for prefix match.
    const homeLinux = homeUnc.replace(/\\/g, '/').replace(/^\/\/(wsl\.localhost|wsl\$)\/[^/]+/i, '')
    if (homeLinux && (linuxPath === homeLinux || linuxPath.startsWith(`${homeLinux}/`))) {
      preferred.push(distro)
    } else {
      others.push(distro)
    }
  }
  return preferred.length > 0 ? [...preferred, ...others] : [...distros]
}

/**
 * WSL Codex sessions live under the guest managed home, not Windows AppData.
 * Mirror AI Vault's dual-root discovery so id-based resolve finds them when
 * the hook path is missing or still Linux-only.
 */
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

// Why: node:path.join collapses UNC roots on some Node builds; keep the share
// prefix intact when appending guest-relative segments under a WSL home.
function joinWindowsUnc(root: string, ...segments: string[]): string {
  const base = root.replace(/[\\/]+$/, '')
  const rest = segments.join('\\').replace(/^[\\/]+/, '')
  return `${base}\\${rest}`
}
