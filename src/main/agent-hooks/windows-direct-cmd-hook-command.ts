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
  // Why: neutral JSON when the script is missing (#14818), with no interpreter to Test-Path with.
  // Valid in bash and cmd.exe; PowerShell 5.1 rejects `||`, which is what gates this on Git Bash.
  // It also fires when cmd.exe itself exits non-zero (a failing AutoRun), printing `{}` twice —
  // on that same box the encoded launcher exited 1 instead, so neither shape is clean there.
  // Stderr stays unredirected: `2>nul` writes a literal `nul` file into the cwd under MSYS.
  return `${invocation} || echo {}`
}
