import {
  remoteInstallListingRegexSource,
  type RemoteInstallModel
} from '../managed-server/install/remote-install-model'
import type { RemoteHostPlatform } from './ssh-remote-platform'
import { isWindowsRemoteHost, joinRemotePath, remoteDirname } from './ssh-remote-platform'
import { powerShellCommand } from './ssh-remote-powershell'
import { quotePowerShellLiteral as powerShellLiteral } from '../../shared/powershell-native-argument'
import { quotePosixShell } from '../../shared/shell-argument-quoting'

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

/** Require the directory and every declared regular-file artifact; incomplete installs must report missing. */
export function probeRemoteInstallCompleteCommand(
  host: RemoteHostPlatform,
  remoteInstallDir: string,
  requiredFilenames: readonly string[]
): string {
  if (!isWindowsRemoteHost(host)) {
    // Use relative artifacts inside a subshell to fit gateway exec budgets without leaking cd (#30491).
    const fileTests = requiredFilenames
      .map((filename) => `&& test -f ${quotePosixShell(filename)} `)
      .join('')
    return `(cd ${quotePosixShell(remoteInstallDir)} 2>/dev/null ${fileTests}) && echo OK || echo MISSING`
  }
  const required = requiredFilenames.map((filename) =>
    joinRemotePath(host, remoteInstallDir, filename)
  )
  return powerShellCommand(
    [
      `$dir = ${powerShellLiteral(remoteInstallDir)}`,
      `$required = @(${required.map((path) => powerShellLiteral(path)).join(', ')})`,
      '$ok = Test-Path -LiteralPath $dir -PathType Container',
      'foreach ($f in $required) { if (-not (Test-Path -LiteralPath $f -PathType Leaf)) { $ok = $false } }',
      "if ($ok) { 'OK' } else { 'MISSING' }"
    ].join('; ')
  )
}

export const MAX_REMOTE_INSTALL_GC_LISTING_ENTRIES = 64

/** Scope both listing glob and validation regex by install model so orcad GC never even receives legacy relay directory names. */
export function listRemoteInstallBaseDirsCommand(
  host: RemoteHostPlatform,
  baseDir: string,
  model: RemoteInstallModel
): string {
  const namePattern = remoteInstallListingRegexSource(model)
  if (!isWindowsRemoteHost(host)) {
    const statusPrefix = '__ORCA_RELAY_GC_FIND_STATUS__'
    return [
      `base=${quotePosixShell(baseDir)}; [ -d "$base" ] || exit 0;`,
      `{ find "$base" -mindepth 1 -maxdepth 1 -type d -name '${model.dirPrefix}-*' -print; status=$?; printf '\n${statusPrefix}%s\n' "$status"; } |`,
      String.raw`awk 'BEGIN { count=0; status=-1 } /^${statusPrefix}[0-9]+$/ { status=substr($0, ${statusPrefix.length + 1}); next } { name=$0; sub(/^.*\//, "", name); if (name ~ /${namePattern}/ && count < ${MAX_REMOTE_INSTALL_GC_LISTING_ENTRIES}) { entries[count++]=name } } END { if (status != 0) exit 1; for (i=0; i<count; i++) print entries[i] }'`
    ].join(' ')
  }
  return powerShellCommand(
    [
      "$ErrorActionPreference = 'Stop'",
      `$base = ${powerShellLiteral(baseDir)}`,
      'if (Test-Path -LiteralPath $base -PathType Container) {',
      // PowerShell single-quoted strings already preserve regex backslashes.
      `Get-ChildItem -LiteralPath $base -Directory -Filter '${model.dirPrefix}-*' -ErrorAction Stop | Where-Object { $_.Name -match '${namePattern}' } | Select-Object -First ` +
        `${MAX_REMOTE_INSTALL_GC_LISTING_ENTRIES} | ForEach-Object { $_.Name }`,
      '}'
    ].join('\n')
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
