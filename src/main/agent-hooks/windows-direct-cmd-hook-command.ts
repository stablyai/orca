// Why: a drive-letter path only. WINDOWS_CMD_SAFE_PATH also admits a UNC profile, and
// `//server/share/...` is not a command cmd.exe reliably starts.
const WINDOWS_DRIVE_LETTER_PATH = /^[A-Za-z]:\\/

// Why (#19187): WINDOWS_CMD_SAFE_PATH excludes the space, so `C:\Users\First Last` — an ordinary
// profile shape — returned null and kept the encoded launcher #18875 removed, with none of that
// fix's benefit. A space is the one character a surrounding pair of double quotes fixes in both
// hosts; everything the shared class already excluded (`%`, `!`, `^`, `&`, `(`, `)`, quotes,
// non-ASCII) stays excluded, because quoting cannot save those — cmd expands `%VAR%` inside
// double quotes, and `!VAR!` too under delayed expansion. Local to this file rather than a
// widening of the shared class, which has other callers.
// Precedent: `runtime-home-hook-command.ts` already spells its Windows script path
// always-quoted, and its hazard list (`& ^ ( ) ; , = % !`) likewise does not include the space.
const WINDOWS_CMD_QUOTABLE_PATH = /^[A-Za-z0-9_.:\\~ -]+$/

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
  if (!WINDOWS_DRIVE_LETTER_PATH.test(scriptPath) || !WINDOWS_CMD_QUOTABLE_PATH.test(scriptPath)) {
    return null
  }
  // Why: forward slashes are the one separator both hosts read, and no token here is a switch
  // MSYS can rewrite — a literal `cmd.exe /d /c <path>` does not survive Git Bash (measured).
  const invocation = scriptPath.replaceAll('\\', '/')
  // Why (#19187): quote unconditionally rather than only when a space is present. One emitted
  // shape means the harnesses and the tests see the same string on every machine; quoting only
  // spaced paths makes the emitted shape depend on whether the runner's own profile has a space
  // (TEMP is profile-scoped), which turns a deterministic contract into a per-box coin flip.
  //
  // Double quotes are inert here for a path this class admits: bash expands `$`, a backtick or a
  // `\` inside double quotes and the class permits none of them by this line (the backslashes it
  // does permit are forward slashes above), and cmd needs the quotes precisely to keep a spaced
  // path one token.
  //
  // One measured exception, so this is not overclaimed: the quoted form does NOT survive
  // `execFileSync('cmd.exe', ['/d','/c', command])`. libuv MSVCRT-quotes that argument (`"` ->
  // `\"`), cmd.exe does not decode backslash escapes, and with four quotes on the line its `/C`
  // rule falls to "old behaviour" — strip the leading quote and the last quote — leaving a
  // command token that starts with a backslash. Dispatch then fails and `|| echo {}` reports
  // exit 0. No consumer spawns cmd that way: a shell (`shell: true` -> `%ComSpec% /d /s /c
  // "<cmd>"`, verbatim) and `bash -c` both run it correctly, and both are measured green.
  const invocationToken = `"${invocation}"`
  // Why: neutral JSON when the script is missing (#14818), with no interpreter to Test-Path with.
  // Valid in bash and cmd.exe; PowerShell 5.1 rejects `||`, which is what gates this on Git Bash.
  // It also fires when cmd.exe itself exits non-zero (a failing AutoRun), printing `{}` twice —
  // on that same box the encoded launcher exited 1 instead, so neither shape is clean there.
  // Stderr stays unredirected: `2>nul` writes a literal `nul` file into the cwd under MSYS.
  return `${invocationToken} || echo {}`
}
