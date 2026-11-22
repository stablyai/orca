export const AGENT_LAUNCH_TOKEN_ENV = 'ORCA_AGENT_LAUNCH_TOKEN'

/** Bind configured launches to their environment and PTY with the same token. */
export function agentLaunchTokenFor(
  launch: { launchConfig?: unknown; launchToken?: string; accountRestart?: { attemptId: string } },
  mint: () => string
): string | undefined {
  return (
    launch.accountRestart?.attemptId ??
    (launch.launchConfig ? (launch.launchToken ?? mint()) : undefined)
  )
}

export function withAgentLaunchToken(
  env: Record<string, string> | undefined,
  launchToken: string | undefined
): Record<string, string> {
  return { ...env, ...(launchToken ? { [AGENT_LAUNCH_TOKEN_ENV]: launchToken } : {}) }
}
