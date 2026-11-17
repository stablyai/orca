import {
  isDrvfsLinuxPath,
  toWindowsWslPath,
  toWindowsWslUncPath
} from '../../../../shared/file-access/wsl-paths'
import { parseWslPath } from '../../../wsl/filesystem/unc-path-access'
import {
  wslAutomountRootFor,
  wslDrivePathUnderRoots
} from '../../../wsl/filesystem/wsl-automount-root'

/** UNC paths become native Linux paths; drive paths stay for the guest to resolve (wsl-guest-drive-path.ts). */
export function translateUncArgForWsl(arg: string): string {
  return parseWslPath(arg)?.linuxPath ?? arg
}

/** Map Linux worktree output to UNC paths Node can open on Windows. */
export function translateWslOutputPaths(
  output: string,
  originalCwd: string,
  options: { wslDistro?: string } = {}
): string {
  return output.replace(/(?<=worktree )(\/.+)$/gm, (linuxPath: string) =>
    translateWslOutputPath(linuxPath, originalCwd, options)
  )
}

/** One absolute Linux path from WSL Git output, as a path Node can open on Windows. */
export function translateWslOutputPath(
  linuxPath: string,
  originalCwd: string,
  options: { wslDistro?: string } = {}
): string {
  const wsl = parseWslPath(originalCwd)
  const distro = wsl?.distro ?? options.wslDistro
  if (!distro || !linuxPath.startsWith('/')) {
    return linuxPath
  }
  // A drive repo's own output names drives under its distro's automount root; drvfs letters are lowercase.
  const root = wslAutomountRootFor(distro)
  const drive =
    wsl || !/^[a-z](?:\/|$)/.test(linuxPath.slice(root.length))
      ? null
      : wslDrivePathUnderRoots(linuxPath, [root])
  if (drive) {
    return drive
  }
  // A repo saved under the distro's view of a drive keeps that spelling: its worktree ids use it.
  const toWindows = wsl && isDrvfsLinuxPath(wsl.linuxPath) ? toWindowsWslUncPath : toWindowsWslPath
  return toWindows(linuxPath, distro)
}
