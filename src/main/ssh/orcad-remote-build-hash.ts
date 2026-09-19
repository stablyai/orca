import type { SshConnection } from './ssh-connection'
import { shellEscape } from './ssh-connection-utils'
import { execCommand } from './ssh-relay-deploy-helpers'
import { isWindowsRemoteHost, joinRemotePath, type RemoteHostPlatform } from './ssh-remote-platform'
import { powerShellCommand, powerShellLiteral } from './ssh-remote-powershell'

const BUILD_HASH_MARKER = '__ORCAD_BUILD_HASH__'

export async function readRemoteOrcadBuildHash(options: {
  conn: SshConnection
  host: RemoteHostPlatform
  remoteInstallDir: string
  signal?: AbortSignal
}): Promise<string> {
  const output = await execCommand(
    options.conn,
    remoteOrcadBuildHashCommand(options.host, options.remoteInstallDir),
    { wrapCommand: options.host.commandDialect !== 'powershell', signal: options.signal }
  )
  const match = output.match(/__ORCAD_BUILD_HASH__\s+([a-fA-F0-9]{16})/u)
  if (!match?.[1]) {
    throw new Error('Could not verify the installed orcad build hash.')
  }
  return match[1].toLowerCase()
}

export function remoteOrcadBuildHashCommand(
  host: RemoteHostPlatform,
  remoteInstallDir: string
): string {
  const entry = joinRemotePath(host, remoteInstallDir, 'orcad.js')
  if (isWindowsRemoteHost(host)) {
    return powerShellCommand(
      `$hash = (Get-FileHash -LiteralPath ${powerShellLiteral(entry)} -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant().Substring(0,16); ` +
        `Write-Output ${powerShellLiteral(BUILD_HASH_MARKER)} $hash`
    )
  }
  const path = shellEscape(entry)
  return [
    `orca_hash=$(if command -v sha256sum >/dev/null 2>&1; then sha256sum ${path} | awk '{print $1}';`,
    `elif command -v shasum >/dev/null 2>&1; then shasum -a 256 ${path} | awk '{print $1}'; fi);`,
    `case "$orca_hash" in [0-9a-fA-F][0-9a-fA-F]*) printf '%s %.16s\n' ${shellEscape(BUILD_HASH_MARKER)} "$orca_hash";; esac`
  ].join(' ')
}
