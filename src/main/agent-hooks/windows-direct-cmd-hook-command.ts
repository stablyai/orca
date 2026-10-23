import {
  isSafeUnicodeWindowsBatchHookPath,
  WINDOWS_CMD_SAFE_PATH,
  wrapWindowsHookCommand
} from './windows-hook-command'

// UNC paths cannot be started consistently by all Windows hook hosts.
const WINDOWS_DRIVE_LETTER_PATH = /^[A-Za-z]:\\/

/** A bare path runs the same under cmd.exe, PowerShell and Git Bash, so no host shell is guessed. */
export function wrapWindowsDirectCmdHookCommand(scriptPath: string): string | null {
  if (!WINDOWS_CMD_SAFE_PATH.test(scriptPath) || !WINDOWS_DRIVE_LETTER_PATH.test(scriptPath)) {
    return null
  }
  // The script owns failure handling; PowerShell 5.1 cannot parse a shell-level `||`.
  return scriptPath.replaceAll('\\', '/')
}

/**
 * Registration for a managed `.cmd` hook: the bare path skips a PowerShell start-up per event
 * (#18875); paths the shells cannot carry bare keep the encoded launcher. A missing script then
 * prints "not recognized" until Orca reinstalls it instead of exiting silently.
 */
export function wrapWindowsBatchHookCommand(scriptPath: string): string {
  return (
    wrapWindowsDirectCmdHookCommand(scriptPath) ??
    wrapWindowsHookCommand(
      scriptPath,
      {},
      // Guarded Unicode .cmd paths skip loading the policy cmdlet (#26382).
      { useProcessPolicyEnvironment: isSafeUnicodeWindowsBatchHookPath(scriptPath) }
    )
  )
}
