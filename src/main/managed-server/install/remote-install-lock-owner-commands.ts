import { quotePosixShell } from '../../../shared/shell/launch/shell-argument-quoting'
import { powerShellCommand } from '../../ssh/remote-exec/ssh-remote-powershell'
import { quotePowerShellLiteral as powerShellLiteral } from '../../../shared/shell/launch/powershell-native-argument'
import {
  isWindowsRemoteHost,
  type RemoteHostPlatform
} from '../../ssh/remote-host/ssh-remote-platform'
import type { InstallLockOwnerFile } from './remote-install-lock-commands'

/** Remove the lock only while its owner file still names `owner`; a successor's lock is left. An
 * owner that cannot be read fails the command, so the caller keeps its token as proof. */
export function removeOwnedInstallLockCommand(
  host: RemoteHostPlatform,
  lockDir: string,
  owner: InstallLockOwnerFile
): string {
  if (!isWindowsRemoteHost(host)) {
    const lock = quotePosixShell(lockDir)
    const parent = quotePosixShell(dirnameOf(lockDir))
    const ownerPath = quotePosixShell(`${lockDir.replace(/\/+$/u, '')}/${owner.fileName}`)
    // "Absent" only where the directory holding it can be searched; an unsearchable path fails.
    return [
      `if [ -x ${parent} ] && [ ! -e ${lock} ] && [ ! -L ${lock} ]; then :;`,
      `elif [ ! -r ${lock} ] || [ ! -x ${lock} ]; then false;`,
      `elif [ ! -e ${ownerPath} ] && [ ! -L ${ownerPath} ]; then :;`,
      `elif current_owner=$(cat ${ownerPath} 2>/dev/null); then`,
      `if [ "$current_owner" = ${quotePosixShell(owner.token)} ]; then rm -rf ${lock}; fi;`,
      'else false; fi'
    ].join(' ')
  }
  // Only a not-found answer means absent; access denied or any other error fails the command.
  const notFound = 'catch [System.IO.FileNotFoundException], [System.IO.DirectoryNotFoundException]'
  return powerShellCommand(
    [
      `$lock = ${powerShellLiteral(lockDir)}`,
      `$owner = Join-Path $lock ${powerShellLiteral(owner.fileName)}`,
      'try {',
      `$lockPresent = $true; try { $null = [System.IO.File]::GetAttributes($lock) } ${notFound} { $lockPresent = $false }`,
      'if ($lockPresent) {',
      // Throws unless the lock can be listed, so an unreadable lock never reads as ownerless.
      '$null = [System.IO.Directory]::GetFileSystemEntries($lock)',
      `$ownerPresent = $true; try { $null = [System.IO.File]::GetAttributes($owner) } ${notFound} { $ownerPresent = $false }`,
      `if ($ownerPresent -and ([System.IO.File]::ReadAllText($owner) -ceq ${powerShellLiteral(owner.token)})) { Remove-Item -LiteralPath $lock -Recurse -Force -ErrorAction Stop }`,
      '}',
      '} catch { exit 1 }'
    ].join('; ')
  )
}

function dirnameOf(path: string): string {
  const trimmed = path.replace(/\/+$/u, '')
  const slash = trimmed.lastIndexOf('/')
  return slash > 0 ? trimmed.slice(0, slash) : '/'
}
