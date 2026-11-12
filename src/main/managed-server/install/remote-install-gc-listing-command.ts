import { remoteInstallListingRegexSource } from './remote-install-model'
import type { RemoteInstallModel } from './remote-install-model'
import type { RemoteHostPlatform } from '../../ssh/remote-host/ssh-remote-platform'
import { isWindowsRemoteHost } from '../../ssh/remote-host/ssh-remote-platform'
import { powerShellCommand } from '../../ssh/remote-exec/ssh-remote-powershell'
import { quotePowerShellLiteral as powerShellLiteral } from '../../../shared/powershell-native-argument'
import { quotePosixShell } from '../../../shared/shell/launch/shell-argument-quoting'

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
