import { WINDOWS_CMD_SAFE_PATH } from './installer-utils'

// Why: a drive-letter path only. WINDOWS_CMD_SAFE_PATH also admits a UNC profile, and
// `//server/share/...` is not a command cmd.exe reliably starts.
const WINDOWS_DRIVE_LETTER_PATH = /^[A-Za-z]:\\/

/**
 * Shortest launcher for a managed Windows `.cmd` hook: the script path itself (#18875).
 *
 * The encoded PowerShell launcher spent a full interpreter start-up per hook event to reach a
 * script that exits at its first `ORCA_PANE_KEY` guard, and left a stdout-holding orphan behind
 * when the hook's timeout kill landed. Measurements and the EDR trade are in
 * `docs/reference/windows-edr-posture.md`.
 *
 * Returns null when the caller must keep the encoded launcher: a path either shell would mangle.
 */
export function wrapWindowsDirectCmdHookCommand(scriptPath: string): string | null {
  if (!WINDOWS_CMD_SAFE_PATH.test(scriptPath) || !WINDOWS_DRIVE_LETTER_PATH.test(scriptPath)) {
    return null
  }
  // Why: forward slashes are the one separator both hosts read, and no token here is a switch
  // MSYS can rewrite — a literal `cmd.exe /d /c <path>` does not survive Git Bash (measured).
  const invocation = scriptPath.replaceAll('\\', '/')
  // Why (#21514): bare script path avoids shell operators that force Claude Code into WSL bash and mask failures.
  return invocation
}
