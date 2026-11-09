import type { RemoteHostPlatform } from '../remote-host/ssh-remote-platform'
import { isWindowsRemoteHost, remoteDirname } from '../remote-host/ssh-remote-platform'

import { powerShellCommand } from './ssh-remote-powershell'
import { quotePowerShellLiteral as powerShellLiteral } from '../../../shared/powershell-native-argument'
import { quotePosixShell } from '../../../shared/shell/launch/shell-argument-quoting'

export function readRemoteHomeCommand(host: RemoteHostPlatform): string {
  if (!isWindowsRemoteHost(host)) {
    return 'echo $HOME'
  }
  return powerShellCommand("Write-Output ([Environment]::GetFolderPath('UserProfile'))")
}

export function removeRemoteFileCommand(host: RemoteHostPlatform, remotePath: string): string {
  if (!isWindowsRemoteHost(host)) {
    return `rm -f ${quotePosixShell(remotePath)} 2>/dev/null; true`
  }
  return powerShellCommand(
    `Remove-Item -LiteralPath ${powerShellLiteral(remotePath)} -Force -ErrorAction SilentlyContinue`
  )
}

export function removeRemoteTreeCommand(host: RemoteHostPlatform, remotePath: string): string {
  if (!isWindowsRemoteHost(host)) {
    return `rm -rf ${quotePosixShell(remotePath)}`
  }
  return powerShellCommand(
    `Remove-Item -LiteralPath ${powerShellLiteral(remotePath)} -Recurse -Force -ErrorAction SilentlyContinue`
  )
}

export function moveRemoteTreeCommand(
  host: RemoteHostPlatform,
  sourcePath: string,
  destinationPath: string
): string {
  if (!isWindowsRemoteHost(host)) {
    return `mv ${quotePosixShell(sourcePath)} ${quotePosixShell(destinationPath)} 2>&1 && echo MOVED || echo BUSY`
  }
  return powerShellCommand(
    [
      'try {',
      `Move-Item -LiteralPath ${powerShellLiteral(sourcePath)} -Destination ${powerShellLiteral(destinationPath)} -ErrorAction Stop`,
      "'MOVED'",
      `} catch { 'BUSY' }`
    ].join('; ')
  )
}

// A concurrent installer may already have recreated the original directory.
export function restoreRemoteTreeCommand(
  host: RemoteHostPlatform,
  source: string,
  destination: string
): string {
  if (isWindowsRemoteHost(host)) {
    return powerShellCommand(
      `if (-not (Test-Path -LiteralPath ${powerShellLiteral(destination)})) { Move-Item -LiteralPath ${powerShellLiteral(source)} -Destination ${powerShellLiteral(destination)} -ErrorAction Stop; 'MOVED' } else { 'BUSY' }`
    )
  }
  return `if [ ! -e ${quotePosixShell(destination)} ] && [ ! -L ${quotePosixShell(destination)} ]; then mv ${quotePosixShell(source)} ${quotePosixShell(destination)} && echo MOVED; else echo BUSY; fi`
}

export function writeRemoteEmptyFileCommand(host: RemoteHostPlatform, remotePath: string): string {
  if (!isWindowsRemoteHost(host)) {
    return `touch ${quotePosixShell(remotePath)}`
  }
  return powerShellCommand(
    `Set-Content -LiteralPath ${powerShellLiteral(remotePath)} -Value '' -NoNewline`
  )
}

export function probeFileExistsCommand(host: RemoteHostPlatform, remotePath: string): string {
  if (!isWindowsRemoteHost(host)) {
    return `test -f ${quotePosixShell(remotePath)} && echo COMPLETE || echo PARTIAL`
  }
  return powerShellCommand(
    `if (Test-Path -LiteralPath ${powerShellLiteral(remotePath)} -PathType Leaf) { 'COMPLETE' } else { 'PARTIAL' }`
  )
}

export function commandWithNodePath(
  host: RemoteHostPlatform,
  nodePath: string,
  remoteDir: string,
  command: string
): string {
  const nodeBinDir = remoteDirname(nodePath, host)
  if (!isWindowsRemoteHost(host)) {
    return `export PATH=${quotePosixShell(nodeBinDir)}:$PATH && cd ${quotePosixShell(remoteDir)} && ${command}`
  }
  const windowsNodeBinDir = nodeBinDir.replace(/\//g, '\\')
  return powerShellCommand(
    [
      `$env:PATH = ${powerShellLiteral(windowsNodeBinDir)} + ';' + $env:PATH`,
      `Set-Location -ErrorAction Stop -LiteralPath ${powerShellLiteral(remoteDir)}`,
      command
    ].join('; ')
  )
}
