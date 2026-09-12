import { randomUUID } from 'node:crypto'
import type { SshConnection } from './ssh-connection'
import { execCommand, isUnconfirmedSshCommandTermination } from './ssh-relay-deploy-helpers'
import { shellEscape } from './ssh-connection-utils'
import { removeRemoteFileCommand } from './ssh-remote-commands'
import { isWindowsRemoteHost, type RemoteHostPlatform } from './ssh-remote-platform'
import { powerShellCommand, powerShellLiteral } from './ssh-remote-powershell'

type OrcadRemoteRecordFileOptions = {
  conn: SshConnection
  host: RemoteHostPlatform
  signal?: AbortSignal
}

export async function readBoundedOrcadRemoteRecord(
  options: OrcadRemoteRecordFileOptions,
  path: string,
  maxBytes: number
): Promise<string> {
  const command = isWindowsRemoteHost(options.host)
    ? powerShellCommand(
        `if (Test-Path -LiteralPath ${powerShellLiteral(path)}) { ` +
          `if (-not (Test-Path -LiteralPath ${powerShellLiteral(path)} -PathType Leaf)) { ` +
          `throw 'orcad record is not a file' }; ` +
          `if ((Get-Item -LiteralPath ${powerShellLiteral(path)} -Force).Length -gt ` +
          `${maxBytes}) { throw 'orcad record is too large' }; ` +
          `Write-Output ([IO.File]::ReadAllText(${powerShellLiteral(path)})) }`
      )
    : `if [ -e ${shellEscape(path)} ]; then [ -f ${shellEscape(path)} ] || exit 65; ` +
      `size=$(wc -c < ${shellEscape(path)}) || exit 65; ` +
      `[ "$size" -le ${maxBytes} ] || exit 65; ` +
      `cat ${shellEscape(path)}; fi`
  return execCommand(options.conn, command, {
    wrapCommand: options.host.commandDialect !== 'powershell',
    signal: options.signal
  })
}

export async function writeAtomicOrcadRemoteRecord(
  options: OrcadRemoteRecordFileOptions,
  path: string,
  contents: string
): Promise<void> {
  const partialPath = `${path}.partial.${process.pid}.${randomUUID()}`
  const command = isWindowsRemoteHost(options.host)
    ? powerShellCommand(
        [
          `$partial = ${powerShellLiteral(partialPath)}`,
          `$target = ${powerShellLiteral(path)}`,
          '$utf8 = New-Object System.Text.UTF8Encoding($false)',
          `[IO.File]::WriteAllText($partial, ${powerShellLiteral(contents)}, $utf8)`,
          'if (Test-Path -LiteralPath $target -PathType Leaf) { [IO.File]::Replace($partial, $target, $null) } else { [IO.File]::Move($partial, $target) }'
        ].join('; ')
      )
    : `umask 077; printf %s ${shellEscape(contents)} > ${shellEscape(partialPath)} && mv -f ${shellEscape(partialPath)} ${shellEscape(path)}`
  try {
    await execCommand(options.conn, command, {
      wrapCommand: options.host.commandDialect !== 'powershell',
      signal: options.signal
    })
  } catch (error) {
    if (!isUnconfirmedSshCommandTermination(error)) {
      await execCommand(options.conn, removeRemoteFileCommand(options.host, partialPath), {
        wrapCommand: options.host.commandDialect !== 'powershell'
      }).catch(() => {})
    }
    throw error
  }
}
