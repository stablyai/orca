import { gunzipSync, gzipSync } from 'node:zlib'
import { encodePowerShellCommand } from '../../shared/powershell-command-encoding'
import { CMD_EXE_COMMAND_LINE_MAX_CHARS } from '../providers/windows-shell-args'

// Stock sshd reparses exec through cmd.exe; budget below its 8,191-character ceiling for the added /c wrapper.
const WINDOWS_REMOTE_COMMAND_LINE_BUDGET_CHARS = 8_000

/** Choose PowerShell 7 only after probing; stock Windows supplies 5.1, which mishandles redirected binary stdin. */
type WindowsPowerShellExecutable = 'powershell.exe' | 'pwsh.exe'

// Encoding protects DefaultShell reparsing; ExecutionPolicy Bypass is ineffective for inline code and adds EDR risk.
// INVARIANT: remote payloads must not load script files (.ps1/.psm1, dot-source or -File); execution policy gates those.
// If file loading becomes necessary, set process policy in-payload as buildWindowsStartupCommand does; never restore the CLI bypass switch.
// ssh-remote-powershell.test.ts enforces static importers; compressed Invoke-Expression remains inline.
export function powerShellCommand(
  script: string,
  executable: WindowsPowerShellExecutable = 'powershell.exe'
): string {
  const inline = encodedPowerShellCommand(script, executable)
  if (inline.length <= WINDOWS_REMOTE_COMMAND_LINE_BUDGET_CHARS) {
    return inline
  }
  // Gzip offsets UTF-16LE/base64 expansion enough to fit repetitive scripts under cmd's limit.
  const compressed = encodedPowerShellCommand(selfExtractingPowerShellScript(script), executable)
  if (compressed.length > WINDOWS_REMOTE_COMMAND_LINE_BUDGET_CHARS) {
    throw new Error(
      `Remote Windows command needs ${compressed.length} characters; Orca budgets ${WINDOWS_REMOTE_COMMAND_LINE_BUDGET_CHARS} for a line sshd hands to cmd.exe, which itself refuses more than ${CMD_EXE_COMMAND_LINE_MAX_CHARS}.`
    )
  }
  return compressed
}

function encodedPowerShellCommand(script: string, executable: WindowsPowerShellExecutable): string {
  return `${executable} -NoProfile -NonInteractive -EncodedCommand ${encodePowerShellCommand(script)}`
}

/** Prefix bootstrap variables so payload scripts cannot shadow them. */
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
