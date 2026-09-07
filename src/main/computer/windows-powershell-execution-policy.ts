/**
 * Execution-policy handling for the Windows computer-use runtime script.
 *
 * Why not `Bypass` outright: it is the highest-weighted token on a
 * powershell.exe command line for Defender for Endpoint, and the shipped
 * runtime.ps1 does not need it — NSIS extraction writes no Zone.Identifier, so
 * an unsigned local script runs under `RemoteSigned`. `Restricted` is still the
 * Windows client default though, so a policy-blocked start must fall back once
 * rather than leaving computer use broken.
 */
export type WindowsExecutionPolicy = 'RemoteSigned' | 'Bypass'

export const PREFERRED_WINDOWS_EXECUTION_POLICY: WindowsExecutionPolicy = 'RemoteSigned'
export const FALLBACK_WINDOWS_EXECUTION_POLICY: WindowsExecutionPolicy = 'Bypass'

/**
 * Matches the SecurityError PowerShell emits for `-File` under a blocking policy.
 *
 * Every alternative is a PowerShell or .NET identifier, never prose. The prose
 * differs by policy ("running scripts is disabled" under Restricted, "is not
 * digitally signed" under RemoteSigned), is localized, and PowerShell hard-wraps
 * it mid-sentence at the console width, so it can anchor nothing.
 *
 * The `\b` after UnauthorizedAccess is the whole discriminator and must not be
 * dropped. `UnauthorizedAccess` is the FullyQualifiedErrorId of a policy block,
 * but it is also a strict prefix of `UnauthorizedAccessException`, which .NET
 * raises for an ordinary locked or ACL-denied file: an AV scan holding
 * runtime.ps1, a locked CSC temp directory, a roaming-profile hiccup. Matching
 * that escalates to `Bypass` for the rest of the session — the exact command
 * line token this stack exists to stop emitting — and on the one-shot path
 * replays an operation that already ran.
 *
 * Anchoring on the `FullyQualifiedErrorId:`/`CategoryInfo:` labels would be more
 * precise still, but the labels are localized where these values are not, so a
 * non-English host would stop recognising a real block and lose the fallback.
 */
const EXECUTION_POLICY_BLOCKED = /\bUnauthorizedAccess\b|\bSecurityError\b|about_Execution_Policies/

export function isExecutionPolicyBlocked(text: string): boolean {
  return EXECUTION_POLICY_BLOCKED.test(text)
}

export function windowsPowerShellRuntimeArgs(
  scriptPath: string,
  policy: WindowsExecutionPolicy,
  scriptArgs: readonly string[] = []
): string[] {
  return [
    // -NoLogo: a banner on stdout would be read as a malformed response line.
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    policy,
    '-File',
    scriptPath,
    ...scriptArgs
  ]
}
