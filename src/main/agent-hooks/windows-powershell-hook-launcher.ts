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
