import { parseWslPath } from '../wsl'

export type BundledRipgrepWslRouting = {
  /** Distro the spawn is routed into via wsl.exe; unset runs the host binary. */
  wslDistro?: string
  /** Set when rg runs inside WSL, so it emits Linux paths the caller translates back. */
  wslDistroForOutput?: string
}

const WINDOWS_DRIVE_PATH = /^[A-Za-z]:[\\/]/

/**
 * Where Orca's ripgrep runs for a local workspace root, given the distro the project's git runs in.
 *
 * Why a Windows drive root stays on the host even under a WSL project runtime: rg only reads files,
 * so unlike git there is no index whose stat cache two writers would invalidate, and the host reads
 * NTFS directly instead of through drvfs (content search measured ~18x faster on a 21.6k-file repo).
 * Following symlinks stays in WSL: Windows cannot resolve symlinks WSL created on drvfs.
 */
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
