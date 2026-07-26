import { powerShellCommand, powerShellLiteral } from './ssh-remote-powershell'

export const WINDOWS_RELAY_LOG_TAIL_MAX_BYTES = 64 * 1024

export function windowsRelayTailLogCommand(logFile: string, errFile: string): string {
  const script = [
    'function Read-OrcaLogTail {',
    'param([string]$Path, [string]$Missing)',
    'if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $Missing }',
    '$stream = $null',
    'try {',
    '$stream = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)',
    `$readLength = [int][Math]::Min([long]${WINDOWS_RELAY_LOG_TAIL_MAX_BYTES}, $stream.Length)`,
    '$buffer = New-Object byte[] $readLength',
    '$null = $stream.Seek(-[long]$readLength, [System.IO.SeekOrigin]::End)',
    '$offset = 0',
    'while ($offset -lt $readLength) {',
    '$bytesRead = $stream.Read($buffer, $offset, $readLength - $offset)',
    'if ($bytesRead -eq 0) { break }',
    '$offset += $bytesRead',
    '}',
    'return [System.Text.Encoding]::UTF8.GetString($buffer, 0, $offset)',
    "} catch { return '(unable to read log)' }",
    'finally { if ($null -ne $stream) { $stream.Dispose() } }',
    '}',
    `[Console]::Out.Write((Read-OrcaLogTail ${powerShellLiteral(logFile)} '(no stdout log)'))`,
    '[Console]::Out.Write("`n--- stderr ---`n")',
    `[Console]::Out.Write((Read-OrcaLogTail ${powerShellLiteral(errFile)} '(no stderr log)'))`
  ].join('\n')
  return powerShellCommand(script)
}
