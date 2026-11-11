// Absolute forward-slash paths prevent PATH hijacking and survive cmd.exe and Git Bash.
export function getWindowsSystem32Path(relativePath: string): string {
  const systemRoot = process.env.SystemRoot || 'C:\\Windows'
  return `${systemRoot.replaceAll('\\', '/')}/System32/${relativePath}`
}

export function getWindowsPowerShellExecutablePath(): string {
  return getWindowsSystem32Path('WindowsPowerShell/v1.0/powershell.exe')
}

/** AV blocks WindowStyle Hidden with EncodedCommand (#16003); omit it and use direct launchers where possible. */
export const WINDOWS_POWERSHELL_HOOK_SWITCHES = '-NoProfile'

// Suppress progress before Set-ExecutionPolicy autoloads modules or CLIXML can corrupt merged JSON output.
const HOOK_PROGRESS_SILENCER = "$ProgressPreference='SilentlyContinue'; "

/** Process-scope bypass preserves .ps1 hooks; swallow GPO failures to keep stderr clear for JSON consumers. */
const HOOK_EXECUTION_POLICY_BYPASS =
  'try { Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force -ErrorAction SilentlyContinue } catch {}; '

export type WindowsPowerShellHookOptions = { useProcessPolicyEnvironment?: boolean }

// Encoding prevents cmd.exe and MSYS from rewriting paths and switches.
export function encodeWindowsPowerShellHookCommand(
  command: string,
  options: WindowsPowerShellHookOptions = {}
): string {
  // Process scope uses this variable; Group Policy still takes precedence.
  const policy = options.useProcessPolicyEnvironment
    ? "$env:PSExecutionPolicyPreference='Bypass'; "
    : HOOK_EXECUTION_POLICY_BYPASS
  return Buffer.from(`${HOOK_PROGRESS_SILENCER}${policy}${command}`, 'utf16le').toString('base64')
}

export function wrapWindowsPowerShellEncodedCommand(
  command: string,
  options: WindowsPowerShellHookOptions = {}
): string {
  return `${getWindowsPowerShellExecutablePath()} ${WINDOWS_POWERSHELL_HOOK_SWITCHES} -EncodedCommand ${encodeWindowsPowerShellHookCommand(command, options)}`
}
