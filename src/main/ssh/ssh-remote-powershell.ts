import { gunzipSync, gzipSync } from 'node:zlib'
import { encodePowerShellCommand } from '../../shared/powershell-command-encoding'
import { CMD_EXE_COMMAND_LINE_MAX_CHARS } from '../providers/windows-shell-args'
export {
  quotePowerShellLiteral as powerShellLiteral,
  quotePowerShellNativeArgument as powerShellNativeArg
} from '../../shared/powershell-native-argument'

// Why cmd.exe and not the 32767 CreateProcess cap: Windows OpenSSH runs every exec request
// through sshd's DefaultShell, cmd.exe on a stock install. Budget under cmd.exe's own ceiling
// to leave room for the `/c` wrapper sshd adds before cmd.exe counts the line.
const WINDOWS_REMOTE_COMMAND_LINE_BUDGET_CHARS = 8_000

export function powerShellCommand(script: string): string {
  const inline = encodedPowerShellCommand(script)
  if (inline.length <= WINDOWS_REMOTE_COMMAND_LINE_BUDGET_CHARS) {
    return inline
  }
  // Why: these scripts are repetitive enough that gzip beats the UTF-16LE tax by
  // ~4x, which is the difference between a line cmd.exe runs and one it refuses.
  const compressed = encodedPowerShellCommand(selfExtractingPowerShellScript(script))
  if (compressed.length > WINDOWS_REMOTE_COMMAND_LINE_BUDGET_CHARS) {
    throw new Error(
      `Remote Windows command needs ${compressed.length} characters; Orca budgets ${WINDOWS_REMOTE_COMMAND_LINE_BUDGET_CHARS} for a line sshd hands to cmd.exe, which itself refuses more than ${CMD_EXE_COMMAND_LINE_MAX_CHARS}.`
    )
  }
  return compressed
}

function encodedPowerShellCommand(script: string): string {
  return `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encodePowerShellCommand(script)}`
}

/** Orca-prefixed names so the payload can never shadow the bootstrap's own state. */
function selfExtractingPowerShellScript(script: string): string {
  const payload = gzipSync(Buffer.from(script, 'utf-8'), { level: 9 }).toString('base64')
  return [
    `$OrcaScriptBytes = [Convert]::FromBase64String('${payload}')`,
    '$OrcaScriptMemory = New-Object System.IO.MemoryStream -ArgumentList (,$OrcaScriptBytes)',
    '$OrcaScriptGzip = New-Object System.IO.Compression.GZipStream -ArgumentList $OrcaScriptMemory, ([System.IO.Compression.CompressionMode]::Decompress)',
    '$OrcaScriptReader = New-Object System.IO.StreamReader -ArgumentList $OrcaScriptGzip, ([System.Text.Encoding]::UTF8)',
    '$OrcaScriptText = $OrcaScriptReader.ReadToEnd()',
    '$OrcaScriptReader.Dispose()',
    'Invoke-Expression $OrcaScriptText'
  ].join('\n')
}

/** Inverse of `powerShellCommand`: the script the host will actually run. */
export function decodeRemotePowerShellScript(command: string): string {
  const encoded = command.match(/-EncodedCommand\s+([A-Za-z0-9+/=]+)/u)?.[1]
  if (!encoded) {
    return command
  }
  const script = Buffer.from(encoded, 'base64').toString('utf16le')
  const payload = script.match(
    /^\$OrcaScriptBytes = \[Convert\]::FromBase64String\('([A-Za-z0-9+/=]+)'\)/u
  )?.[1]
  return payload ? gunzipSync(Buffer.from(payload, 'base64')).toString('utf-8') : script
}
