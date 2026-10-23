import { stat } from 'node:fs/promises'
import { hostname as getHostname } from 'node:os'
import { parseWslUncPath, toWindowsWslPath } from '../../shared/wsl-paths'

export function normalizeWslColdRestoreCwd(args: {
  recoveredCwd: string
  requestedCwd?: string
  wslDistro?: string
  platform?: NodeJS.Platform
  hostname?: string
}): string | undefined {
  if ((args.platform ?? process.platform) !== 'win32' || !args.wslDistro) {
    return args.recoveredCwd
  }

  if (/^[A-Za-z]:[\\/]/.test(args.recoveredCwd)) {
    return args.recoveredCwd
  }

  const wslPath = parseWslUncPath(args.recoveredCwd)
  if (wslPath) {
    return wslPath.distro.toLowerCase() === args.wslDistro.toLowerCase()
      ? args.recoveredCwd
      : args.requestedCwd
  }

  if (/^\/(?!\/)/.test(args.recoveredCwd)) {
    return toWindowsWslPath(args.recoveredCwd, args.wslDistro)
  }

  const uncMatch = args.recoveredCwd.match(/^[\\/]{2}([^\\/]+)[\\/]([^\\/]+)([\\/].*)?$/)
  if (uncMatch?.[1].toLowerCase() === (args.hostname ?? getHostname()).toLowerCase()) {
    const linuxPath = `/${uncMatch[2]}${(uncMatch[3] ?? '').replace(/\\/g, '/')}`
    return toWindowsWslPath(linuxPath, args.wslDistro)
  }

  return args.requestedCwd
}

/**
 * The restored folder, or `fallback` when it is gone: a WSL pane's folder may be deleted while it
 * sleeps, and spawning into it would fail the wake instead of opening at the workspace root.
 */
export async function existingWslColdRestoreCwd(cwd: string, fallback: string): Promise<string> {
  if (cwd === fallback) {
    return cwd
  }
  try {
    return (await stat(cwd)).isDirectory() ? cwd : fallback
  } catch {
    return fallback
  }
}
