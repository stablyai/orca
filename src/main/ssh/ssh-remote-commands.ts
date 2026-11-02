import {
  remoteInstallListingRegexSource,
  type RemoteInstallModel
} from '../managed-server/install/remote-install-model'
import type { RemoteHostPlatform } from './ssh-remote-platform'
import { isWindowsRemoteHost, joinRemotePath, remoteDirname } from './ssh-remote-platform'
import { powerShellCommand } from './ssh-remote-powershell'
import { quotePowerShellLiteral as powerShellLiteral } from '../../shared/powershell-native-argument'
import { shellEscape } from './ssh-connection-utils'

export function readRemoteHomeCommand(host: RemoteHostPlatform): string {
  if (!isWindowsRemoteHost(host)) {
    return 'echo $HOME'
  }
  return powerShellCommand("Write-Output ([Environment]::GetFolderPath('UserProfile'))")
}

export function removeRemoteFileCommand(host: RemoteHostPlatform, remotePath: string): string {
  if (!isWindowsRemoteHost(host)) {
    return `rm -f ${shellEscape(remotePath)} 2>/dev/null; true`
  }
  return powerShellCommand(
    `Remove-Item -LiteralPath ${powerShellLiteral(remotePath)} -Force -ErrorAction SilentlyContinue`
  )
}

export function removeRemoteTreeCommand(host: RemoteHostPlatform, remotePath: string): string {
  if (!isWindowsRemoteHost(host)) {
    return `rm -rf ${shellEscape(remotePath)}`
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
    return `mv ${shellEscape(sourcePath)} ${shellEscape(destinationPath)} 2>&1 && echo MOVED || echo BUSY`
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
  return `if [ ! -e ${shellEscape(destination)} ] && [ ! -L ${shellEscape(destination)} ]; then mv ${shellEscape(source)} ${shellEscape(destination)} && echo MOVED; else echo BUSY; fi`
}

export function writeRemoteEmptyFileCommand(host: RemoteHostPlatform, remotePath: string): string {
  if (!isWindowsRemoteHost(host)) {
    return `touch ${shellEscape(remotePath)}`
  }
  return powerShellCommand(
    `Set-Content -LiteralPath ${powerShellLiteral(remotePath)} -Value '' -NoNewline`
  )
}

/**
 * An install is complete when its directory exists and every named artifact is a regular
 * file inside it. A partial install must read as MISSING, so the caller passes the whole list.
 */
export function probeRemoteInstallCompleteCommand(
  host: RemoteHostPlatform,
  remoteInstallDir: string,
  requiredFilenames: readonly string[]
): string {
  const required = requiredFilenames.map((filename) =>
    joinRemotePath(host, remoteInstallDir, filename)
  )
  if (!isWindowsRemoteHost(host)) {
    const fileTests = required.map((path) => `&& test -f ${shellEscape(path)} `).join('')
    return `test -d ${shellEscape(remoteInstallDir)} ${fileTests}&& echo OK || echo MISSING`
  }
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

/**
 * List one model's version dirs (and its own tombstones) under `~/.orca-remote/`.
 *
 * The model scopes BOTH the `find`/`Get-ChildItem` glob and the validating regex. That
 * double filter is the on-the-wire half of the GC ownership rule: an orcad GC pass never
 * even receives a relay directory name, so it cannot delete one through a later bug.
 */
export function listRemoteInstallBaseDirsCommand(
  host: RemoteHostPlatform,
  baseDir: string,
  model: RemoteInstallModel
): string {
  const namePattern = remoteInstallListingRegexSource(model)
  if (!isWindowsRemoteHost(host)) {
    const statusPrefix = '__ORCA_RELAY_GC_FIND_STATUS__'
    return [
      `base=${shellEscape(baseDir)}; [ -d "$base" ] || exit 0;`,
      `{ find "$base" -mindepth 1 -maxdepth 1 -type d -name '${model.dirPrefix}-*' -print; status=$?; printf '\n${statusPrefix}%s\n' "$status"; } |`,
      String.raw`awk 'BEGIN { count=0; status=-1 } /^${statusPrefix}[0-9]+$/ { status=substr($0, ${statusPrefix.length + 1}); next } { name=$0; sub(/^.*\//, "", name); if (name ~ /${namePattern}/ && count < ${MAX_REMOTE_INSTALL_GC_LISTING_ENTRIES}) { entries[count++]=name } } END { if (status != 0) exit 1; for (i=0; i<count; i++) print entries[i] }'`
    ].join(' ')
  }
  return powerShellCommand(
    [
      "$ErrorActionPreference = 'Stop'",
      `$base = ${powerShellLiteral(baseDir)}`,
      'if (Test-Path -LiteralPath $base -PathType Container) {',
      // Why the pattern goes in verbatim: a single-quoted PowerShell string is already
      // literal, so `\.` reaches `-match` as the regex escape it is meant to be.
      `Get-ChildItem -LiteralPath $base -Directory -Filter '${model.dirPrefix}-*' -ErrorAction Stop | Where-Object { $_.Name -match '${namePattern}' } | Select-Object -First ` +
        `${MAX_REMOTE_INSTALL_GC_LISTING_ENTRIES} | ForEach-Object { $_.Name }`,
      '}'
    ].join('\n')
  )
}

export function probeFileExistsCommand(host: RemoteHostPlatform, remotePath: string): string {
  if (!isWindowsRemoteHost(host)) {
    return `test -f ${shellEscape(remotePath)} && echo COMPLETE || echo PARTIAL`
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
    return `export PATH=${shellEscape(nodeBinDir)}:$PATH && cd ${shellEscape(remoteDir)} && ${command}`
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
