import {
  isSafeUnicodeWindowsBatchHookPath,
  WINDOWS_CMD_SAFE_PATH,
  wrapWindowsHookCommand
} from './windows-hook-command'

// UNC paths cannot be started consistently by all Windows hook hosts.
const WINDOWS_DRIVE_LETTER_PATH = /^[A-Za-z]:\\/

/** Bare paths avoid guessing which Windows shell the hook host uses. */
export function wrapWindowsDirectCmdHookCommand(scriptPath: string): string | null {
  if (!WINDOWS_CMD_SAFE_PATH.test(scriptPath) || !WINDOWS_DRIVE_LETTER_PATH.test(scriptPath)) {
    return null
  }
  // The script owns failure handling; PowerShell 5.1 cannot parse a shell-level `||`.
  return scriptPath.replaceAll('\\', '/')
}

/** Cmd-safe paths avoid per-event PowerShell startup; other paths use the encoded launcher. */
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
