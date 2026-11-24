/** Bind configured launches to their environment and PTY with the same token. */
export function agentLaunchTokenFor(
  launch: { launchConfig?: unknown; launchToken?: string },
  mint: () => string
): string | undefined {
  return launch.launchConfig ? (launch.launchToken ?? mint()) : undefined
}

export function withAgentLaunchToken(
  env: Record<string, string> | undefined,
  launchToken: string | undefined
): Record<string, string> {
  return { ...env, ...(launchToken ? { ORCA_AGENT_LAUNCH_TOKEN: launchToken } : {}) }
}
