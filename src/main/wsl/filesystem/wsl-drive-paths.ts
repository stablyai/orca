import { quotePosixShell } from '../../../shared/shell/launch/shell-argument-quoting'
import {
  peekWslAutomountRoot,
  wslDrivePathUnderRoots,
  rootUnavailable,
  ROOT_COMMAND,
  type WslAutomountSnapshot
} from './wsl-automount-root'
const DRIVE_PATH = /^([A-Za-z]):[/\\]([\s\S]*)$/

export function isWindowsDrivePath(path: string): boolean {
  return DRIVE_PATH.test(path)
}

/** Windows-drive operands in the selected distro's namespace; other path shapes return null. */
export function wslDrivePathForDistro(
  path: string,
  distro: string,
  snapshot?: WslAutomountSnapshot
): string | null {
  const drive = DRIVE_PATH.exec(path)
  if (!drive) {
    return null
  }
  const root = snapshot ? snapshot.root : peekWslAutomountRoot(distro)
  if (root === null) {
    throw rootUnavailable(distro)
  }
  return `${root}${drive[1].toLowerCase()}/${drive[2].replace(/\\/g, '/')}`
}

export function windowsDrivePathForDistro(
  path: string,
  distro: string,
  snapshot?: WslAutomountSnapshot
): string | null {
  const root = snapshot ? snapshot.root : peekWslAutomountRoot(distro)
  if (root === null) {
    throw rootUnavailable(distro)
  }
  // Guest mount names are case-sensitive, even though the files under a drive are not.
  return /^[a-z](?:\/|$)/.test(path.slice(root.length))
    ? wslDrivePathUnderRoots(path, [root])
    : null
}

/** A cold immediate launch resolves once in its existing guest shell, never on Electron main. */
export function wslAutomountRootShellSetup(failureExitCode = 1): string {
  const code = Math.trunc(failureExitCode)
  return (
    `_orca_wsl_drive_root=$(${ROOT_COMMAND}) || exit ${code}; ` +
    '_orca_wsl_drive_root=${_orca_wsl_drive_root%/}; ' +
    `case "$_orca_wsl_drive_root" in /*/c|/c) _orca_wsl_drive_root=\${_orca_wsl_drive_root%c};; *) exit ${code};; esac; `
  )
}

export function quoteWslDrivePathForShell(path: string, distro: string): string | null {
  const drive = DRIVE_PATH.exec(path)
  if (!drive) {
    return null
  }
  return peekWslAutomountRoot(distro) !== null
    ? quotePosixShell(wslDrivePathForDistro(path, distro) ?? path)
    : `"$_orca_wsl_drive_root"${quotePosixShell(
        `${drive[1].toLowerCase()}/${drive[2].replace(/\\/g, '/')}`
      )}`
}
