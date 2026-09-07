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

/**
 * `pwsh.exe` is PowerShell 7. It is not present on a stock Windows install, so it is only ever
 * chosen after a probe — but where it exists it reads a redirected stdin correctly, which Windows
 * PowerShell 5.1 does not (see `system-ssh-file-binary-transfer.ts`).
 */
export type WindowsPowerShellExecutable = 'powershell.exe' | 'pwsh.exe'

// Why: `-EncodedCommand` is not execution-policy gated (only `-File` is), so `-ExecutionPolicy
// Bypass` was a no-op here — and it is one of the most heavily EDR-flagged PowerShell tokens.
// The base64 stays: this string is re-parsed by the remote host's default SSH shell, which may
// be cmd.exe, PowerShell, or bash.
//
// INVARIANT — no remote payload may load a PowerShell *script file*.
//
// Execution policy has only ever gated loading script files (2.0 through 7.x). Inline
// statements, `& some.exe` and `Add-Type -TypeDefinition` are never gated, which is what makes
// dropping the switch a no-op for every payload we send today — the compressed path below stays
// inline too, since `Invoke-Expression` on a decompressed string loads no file. Loading a script
// file is the one thing the dropped switch actually covered, so a payload that dot-sources, runs
// `& '<x>.ps1'`, calls `Import-Module '<x>.psm1'`, or passes `-File` would silently fail on a
// remote host whose LocalMachine policy is Restricted/AllSigned with no GPO — a break that
// surfaces on someone else's machine, not ours.
//
// If you ever need one, do NOT restore the command-line switch (it loses to a GPO scope anyway,
// so it never covered the locked-down case): set the policy in-payload at process scope, the way
// `buildWindowsStartupCommand` in src/shared/setup-agent-sequencing.ts does.
//
// Enforced by the ratchet in ssh-remote-powershell.test.ts, which scans every importer.
export function powerShellCommand(
  script: string,
  executable: WindowsPowerShellExecutable = 'powershell.exe'
): string {
  const inline = encodedPowerShellCommand(script, executable)
  if (inline.length <= WINDOWS_REMOTE_COMMAND_LINE_BUDGET_CHARS) {
    return inline
  }
  // Why: these scripts are repetitive enough that gzip beats the UTF-16LE tax by
  // ~4x, which is the difference between a line cmd.exe runs and one it refuses.
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
