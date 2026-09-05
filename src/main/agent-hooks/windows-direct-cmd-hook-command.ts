import { WINDOWS_CMD_SAFE_PATH } from './installer-utils'

/**
 * Shortest launcher for a managed Windows `.cmd` hook: the script path itself (#18875).
 *
 * The registered hook used to be `powershell.exe -NoProfile -EncodedCommand <...>` whose
 * whole payload was a `Test-Path` and a call. Measured on Windows 11, invoked as Claude
 * Code invokes it (`printf payload | bash -c -l "<command>"`), median over 12 runs:
 * `bash -l -c true` 177ms, the encoded launcher 471ms, this shape 213ms. Under 10-way
 * concurrency (n=40) the encoded launcher ran 656ms median / 696ms p95 against 296ms /
 * 337ms here. PowerShell start-up was the whole difference, and it was paid before the
 * `.cmd` could reach its `ORCA_PANE_KEY` guard — so sessions outside Orca, 70% of the
 * reporter's 6949 fires, paid it to do nothing.
 *
 * It also removes an interpreter from the chain the hook's timeout kill has to tear down.
 * Killing the hook does not kill its PowerShell grandchild, which still holds the stdout
 * handle the agent reads to EOF: measured, EOF arrived 352ms *after* the kill, when the
 * orphan exited on its own. An orphan that never exits (msys2 creates children suspended
 * and resumes them after, so a kill landing in that window strands one) never yields EOF
 * and the agent waits forever.
 *
 * Returns null when the caller must keep the encoded launcher instead.
 */
export function wrapWindowsDirectCmdHookCommand(scriptPath: string): string | null {
  if (!WINDOWS_CMD_SAFE_PATH.test(scriptPath)) {
    return null
  }
  // Why: forward slashes are the one separator both hosts read — bash eats `\` as an escape,
  // and cmd.exe accepts `/` inside a path. Nothing here is a switch, so MSYS rewrites nothing
  // (a literal `cmd.exe /d /c <path>` does not survive: measured, MSYS ate the `/c`).
  const invocation = scriptPath.replaceAll('\\', '/')
  // Why: neutral JSON when the script is missing (#14818) without an interpreter to Test-Path
  // with. Valid in bash and cmd.exe alike; PowerShell 5.1 rejects `||`, which is what gates
  // this shape on Git Bash being resolvable. The missing-script line stays on stderr
  // unredirected: `2>nul` writes a literal `nul` file into the user's repo under MSYS, and
  // no other sink parses in both hosts (measured).
  return `${invocation} || echo {}`
}
