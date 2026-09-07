import { parseWslPath, toWindowsWslPath } from '../../wsl'

/**
 * Translate Windows-style path arguments to Linux paths for commands run in WSL.
 *
 * Why: callers pass Windows paths as git arguments, which WSL git can't read.
 * UNC paths (\\wsl.localhost\…) become native Linux; drive paths (C:\…) → /mnt/c/…
 */
export function translateArgsForWsl(args: string[]): string[] {
  return args.map(translateArgForWsl)
}

export function translateArgForWsl(arg: string): string {
  // WSL UNC path → native linux path
  const wslInfo = parseWslPath(arg)
  if (wslInfo) {
    return wslInfo.linuxPath
  }

  // Windows drive path (e.g. C:\Users\...) → /mnt/c/Users/...
  const driveMatch = arg.match(/^([A-Za-z]):[/\\](.*)$/)
  if (driveMatch) {
    const driveLetter = driveMatch[1].toLowerCase()
    const rest = driveMatch[2].replace(/\\/g, '/')
    return `/mnt/${driveLetter}/${rest}`
  }

  return arg
}

/**
 * Translate absolute Linux paths in git output back to Windows UNC paths.
 * Why: git-in-WSL emits Linux-native paths, but Orca reads files via Node fs, which needs Windows UNC.
 */
export function translateWslOutputPaths(
  output: string,
  originalCwd: string,
  options: { wslDistro?: string } = {}
): string {
  const wsl = parseWslPath(originalCwd)
  const distro = wsl?.distro ?? options.wslDistro
  if (!distro) {
    return output
  }

  // Rewrite absolute Linux paths in structured git output (e.g. "worktree /home/user/repo/feature") to Windows UNC.
  return output.replace(/(?<=worktree )(\/.+)$/gm, (_match, linuxPath: string) =>
    toWindowsWslPath(linuxPath, distro)
  )
}
