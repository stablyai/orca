/** Prefer RemoteSigned to avoid unnecessary Bypass; retry policy-blocked starts once. */
export type WindowsExecutionPolicy = 'RemoteSigned' | 'Bypass'

export const PREFERRED_WINDOWS_EXECUTION_POLICY: WindowsExecutionPolicy = 'RemoteSigned'
export const FALLBACK_WINDOWS_EXECUTION_POLICY: WindowsExecutionPolicy = 'Bypass'

/**
 * Match stable identifiers because PowerShell labels and prose are localized and wrapped.
 * Keep UnauthorizedAccess word boundaries: UnauthorizedAccessException is an ordinary file error.
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
