import { toWindowsWslUncPath } from '../../../shared/wsl-paths'
import { parseWslPath, toWindowsWslPath } from '../../wsl'

/** Windows arguments need Linux spellings for WSL Git: UNC paths become native and drives map under /mnt. */
export function translateArgsForWsl(args: string[]): string[] {
  return args.map(translateArgForWsl)
}

export function translateArgForWsl(arg: string): string {
  const wslInfo = parseWslPath(arg)
  if (wslInfo) {
    return wslInfo.linuxPath
  }

  const driveMatch = arg.match(/^([A-Za-z]):[/\\](.*)$/)
  if (driveMatch) {
    const driveLetter = driveMatch[1].toLowerCase()
    const rest = driveMatch[2].replace(/\\/g, '/')
    return `/mnt/${driveLetter}/${rest}`
  }

  return arg
}

/** Map Linux worktree output to UNC paths Node can open on Windows. */
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

  // Why: a repo saved under the distro's view, in the distro or on a drive, keeps its /mnt/<drive>
  // worktrees there: worktree ids use that spelling, and their terminals, git and agent sessions stay
  // in WSL. A drive repo routed through WSL git keeps drive paths.
  const toWindows = wsl ? toWindowsWslUncPath : toWindowsWslPath
  return output.replace(/(?<=worktree )(\/.+)$/gm, (_match, linuxPath: string) =>
    toWindows(linuxPath, distro)
  )
}
