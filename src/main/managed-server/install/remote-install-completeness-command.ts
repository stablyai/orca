import type { RemoteHostPlatform } from '../../ssh/remote-host/ssh-remote-platform'
import { isWindowsRemoteHost, joinRemotePath } from '../../ssh/remote-host/ssh-remote-platform'

import { powerShellCommand } from '../../ssh/remote-exec/ssh-remote-powershell'
import { quotePowerShellLiteral as powerShellLiteral } from '../../../shared/powershell-native-argument'
import { quotePosixShell } from '../../../shared/shell/launch/shell-argument-quoting'

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
