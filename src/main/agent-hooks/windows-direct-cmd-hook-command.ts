import { WINDOWS_CMD_SAFE_PATH } from './installer-utils'

// UNC paths cannot be started consistently by all Windows hook hosts.
const WINDOWS_DRIVE_LETTER_PATH = /^[A-Za-z]:\\/

/** A bare path works without guessing whether Claude selected Bash or PowerShell. */
export function wrapWindowsDirectCmdHookCommand(scriptPath: string): string | null {
  if (!WINDOWS_CMD_SAFE_PATH.test(scriptPath) || !WINDOWS_DRIVE_LETTER_PATH.test(scriptPath)) {
    return null
  }
  // The script owns failure handling; PowerShell 5.1 cannot parse a shell-level `||`.
  return scriptPath.replaceAll('\\', '/')
}
