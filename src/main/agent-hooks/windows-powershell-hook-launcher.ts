// Why: centralizing the launcher keeps window suppression consistent across installers (#14815).

// Why: an absolute forward-slash path avoids PATH hijacking and survives cmd.exe and Git Bash.
export function getWindowsSystem32Path(relativePath: string): string {
  const systemRoot = process.env.SystemRoot || 'C:\\Windows'
  return `${systemRoot.replaceAll('\\', '/')}/System32/${relativePath}`
}

export function getWindowsPowerShellExecutablePath(): string {
  return getWindowsSystem32Path('WindowsPowerShell/v1.0/powershell.exe')
}

// Why: unlike conhost, hidden PowerShell relays hook output and exit status (#14818).
export const WINDOWS_POWERSHELL_HOOK_SWITCHES =
  '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden'

// Why: redirected PowerShell progress becomes CLIXML that can corrupt merged JSON output.
const HOOK_PROGRESS_SILENCER = "$ProgressPreference='SilentlyContinue'; "

// Why: encoding shields paths and switches from cmd.exe and MSYS rewriting (#6078, #14815).
export function encodeWindowsPowerShellHookCommand(command: string): string {
  return Buffer.from(`${HOOK_PROGRESS_SILENCER}${command}`, 'utf16le').toString('base64')
}

export function wrapWindowsPowerShellEncodedCommand(command: string): string {
  return `${getWindowsPowerShellExecutablePath()} ${WINDOWS_POWERSHELL_HOOK_SWITCHES} -EncodedCommand ${encodeWindowsPowerShellHookCommand(command)}`
}

function quotePowerShellSingleQuoted(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

// Why: `& .cmd` allocates a new console when Hidden PowerShell has none to inherit (#14828).
// Why: relay stdout/stderr so Claude-hooks-compat consumers still see hook JSON (#14818).
// Why: CreateProcess needs a backslash cmd.exe path; delayed expansion keeps spaces/^/% as data (#6078).
// Why: `/v:on` is only for that path indirection; a nested `/v:off` cmd runs the hook so literal `!` survives.
export function buildWindowsNoWindowCmdHookInvocation(quotedScriptPath: string): string {
  const quotedCmd = quotePowerShellSingleQuoted(
    getWindowsSystem32Path('cmd.exe').replaceAll('/', '\\')
  )
  return [
    '$psi = [System.Diagnostics.ProcessStartInfo]::new()',
    `$psi.FileName = ${quotedCmd}`,
    `$psi.Arguments = '/d /s /v:on /c ""' + ${quotedCmd} + '" /v:off /d /s /c ""!ORCA_WINDOWS_HOOK_CMD!"""'`,
    '$psi.UseShellExecute = $false',
    '$psi.CreateNoWindow = $true',
    '$psi.RedirectStandardInput = $true',
    '$psi.RedirectStandardOutput = $true',
    '$psi.RedirectStandardError = $true',
    '$psi.StandardOutputEncoding = [Console]::OutputEncoding',
    '$psi.StandardErrorEncoding = [Console]::OutputEncoding',
    `$psi.EnvironmentVariables['ORCA_WINDOWS_HOOK_CMD'] = ${quotedScriptPath}`,
    '$stdin = [Console]::In.ReadToEnd()',
    '$p = [System.Diagnostics.Process]::Start($psi)',
    '$outTask = $p.StandardOutput.ReadToEndAsync()',
    '$errTask = $p.StandardError.ReadToEndAsync()',
    'try { $p.StandardInput.Write($stdin); $p.StandardInput.Close() } catch [System.IO.IOException] {}',
    '$p.WaitForExit()',
    '[Console]::Out.Write($outTask.Result)',
    '[Console]::Error.Write($errTask.Result)',
    'exit $p.ExitCode'
  ].join('; ')
}
