import { parseWslPath } from '../wsl'

export type BundledRipgrepWslRouting = {
  /** Distro the spawn is routed into via wsl.exe; unset runs the host binary. */
  wslDistro?: string
  /** Set when rg runs inside WSL, so it emits Linux paths the caller translates back. */
  wslDistroForOutput?: string
}

const WINDOWS_DRIVE_PATH = /^[A-Za-z]:[\\/]/

/** Read Windows roots natively (~18x faster measured on 21.6k files); rg has no git index/cache to invalidate.
 * Symlink-following stays in WSL because Windows cannot resolve guest drvfs symlinks. */
export function resolveBundledRipgrepWslRouting(
  rootPath: string,
  projectWslDistro: string | undefined,
  options: { followSymlinks?: boolean } = {}
): BundledRipgrepWslRouting {
  if (WINDOWS_DRIVE_PATH.test(rootPath) && !options.followSymlinks) {
    return {}
  }
  return {
    wslDistro: projectWslDistro,
    wslDistroForOutput: parseWslPath(rootPath)?.distro ?? projectWslDistro
  }
}
